import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { mulawToPcm16, pcm16ToMulaw } from './transcode.js';

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FLOOT_API_BASE_URL = process.env.FLOOT_API_BASE_URL;
const RELAY_WEBHOOK_SECRET = process.env.RELAY_WEBHOOK_SECRET;

if (!OPENAI_API_KEY || !FLOOT_API_BASE_URL) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Relay Server is running');
});

const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const conversationId = url.searchParams.get('conversationId');
  const caseId = url.searchParams.get('caseId');
  const callSid = url.searchParams.get('callSid');
  const phoneNumber = url.searchParams.get('phoneNumber');

  console.log(`[Twilio] Connection opened for CallSid: ${callSid}`);

  let openAiWs = null;
  let sessionConfig = null;
  let transcriptAccumulator = [];
  let streamSid = null;

  try {
    // 1. Fetch Session Config from Floot
    const configRes = await fetch(`${FLOOT_API_BASE_URL}/_api/voice/realtime-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Secret': RELAY_WEBHOOK_SECRET
      },
      body: JSON.stringify({ conversationId, caseId, callSid, phoneNumber })
    });

    if (!configRes.ok) throw new Error('Failed to fetch session config');
    sessionConfig = await configRes.json();

    // 2. Connect to OpenAI Realtime API
    openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    openAiWs.on('open', () => {
      console.log(`[OpenAI] Connected for CallSid: ${callSid}`);
      
      // Send initial session update using config from Floot
      openAiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: sessionConfig.modalities,
          instructions: sessionConfig.systemPrompt,
          voice: sessionConfig.voice,
          input_audio_format: sessionConfig.inputAudioFormat,
          output_audio_format: sessionConfig.outputAudioFormat,
          turn_detection: sessionConfig.turnDetection,
          tools: sessionConfig.tools,
          temperature: sessionConfig.temperature
        }
      }));
    });

    // 3. Handle OpenAI Messages (Audio OUT -> Twilio, Function Calls -> Floot)
    openAiWs.on('message', async (data) => {
      const event = JSON.parse(data.toString());

      if (event.type === 'response.audio.delta') {
        // Convert PCM16 from OpenAI -> mu-law for Twilio
        const pcmBuffer = Buffer.from(event.delta, 'base64');
        const mulawBuffer = pcm16ToMulaw(pcmBuffer);
        
        ws.send(JSON.stringify({
          event: 'media',
          streamSid: streamSid,
          media: { payload: mulawBuffer.toString('base64') }
        }));
      }

      // Handle server-side function execution
      if (event.type === 'response.function_call_arguments.done') {
        console.log(`[OpenAI] Function called: ${event.name}`);
        try {
          const fnRes = await fetch(`${FLOOT_API_BASE_URL}/_api/voice/realtime-function`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Relay-Secret': RELAY_WEBHOOK_SECRET
            },
            body: JSON.stringify({
              conversationId,
              caseId,
              callSid,
              functionName: event.name,
              arguments: JSON.parse(event.arguments)
            })
          });
          
          const fnData = await fnRes.json();
          
          // Return result back to OpenAI
          openAiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: event.call_id,
              output: JSON.stringify(fnData)
            }
          }));
          openAiWs.send(JSON.stringify({ type: 'response.create' }));
        } catch (error) {
          console.error(`Function execution failed:`, error);
        }
      }

      // Accumulate transcript
      if (event.type === 'conversation.item.created' && event.item.content) {
        const textContent = event.item.content.find(c => c.type === 'text' || c.type === 'transcript');
        if (textContent) {
          transcriptAccumulator.push({
            role: event.item.role,
            content: textContent.text || textContent.transcript,
            timestamp: new Date().toISOString()
          });
        }
      }
    });

  } catch (error) {
    console.error(`[Relay] Setup failed for CallSid ${callSid}:`, error);
    ws.close();
  }

  // 4. Handle Twilio Messages (Audio IN -> OpenAI)
  ws.on('message', (message) => {
    const msg = JSON.parse(message);

    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
    } else if (msg.event === 'media' && openAiWs?.readyState === WebSocket.OPEN) {
      // Convert mu-law from Twilio -> PCM16 for OpenAI
      const mulawBuffer = Buffer.from(msg.media.payload, 'base64');
      const pcmBuffer = mulawToPcm16(mulawBuffer);

      openAiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: pcmBuffer.toString('base64')
      }));
    } else if (msg.event === 'stop') {
      console.log(`[Twilio] Call ended for CallSid: ${callSid}`);
      openAiWs?.close();
    }
  });

  // 5. Cleanup and final API sync
  ws.on('close', async () => {
    console.log(`[Relay] Connection closed for CallSid: ${callSid}`);
    openAiWs?.close();

    // Fire end-of-call pipeline on Floot Backend
    try {
      await fetch(`${FLOOT_API_BASE_URL}/_api/voice/realtime-end`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Relay-Secret': RELAY_WEBHOOK_SECRET
        },
        body: JSON.stringify({
          conversationId,
          caseId,
          callSid,
          transcript: transcriptAccumulator
        })
      });
    } catch (e) {
      console.error('[Relay] Failed to finalize call:', e);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Relay server listening on port ${PORT}`);
});
