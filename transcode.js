import pkg from 'alawmulaw';
const { mulaw } = pkg;

// G.711 mu-law (8kHz, 8-bit) → PCM16 (24kHz, 16-bit) with linear interpolation
export function mulawToPcm16(mulawBuffer) {
  const pcm8k = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcm8k[i] = mulaw.decode(mulawBuffer[i]);
  }

  // Upsample 8kHz → 24kHz (3x)
  const ratio = 3;
  const pcm24k = new Int16Array(pcm8k.length * ratio);
  for (let i = 0; i < pcm8k.length - 1; i++) {
    for (let j = 0; j < ratio; j++) {
      pcm24k[i * ratio + j] = pcm8k[i] + ((pcm8k[i + 1] - pcm8k[i]) * j) / ratio;
    }
  }
  // Fill last sample
  const last = pcm8k.length - 1;
  for (let j = 0; j < ratio; j++) {
    pcm24k[last * ratio + j] = pcm8k[last];
  }

  return Buffer.from(pcm24k.buffer);
}

// PCM16 (24kHz, 16-bit) → G.711 mu-law (8kHz, 8-bit) with averaging
export function pcm16ToMulaw(pcmBuffer) {
  const pcm24k = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);

  // Downsample 24kHz → 8kHz (take every 3rd sample with averaging)
  const ratio = 3;
  const outLen = Math.floor(pcm24k.length / ratio);
  const mulawOut = Buffer.alloc(outLen);

  for (let i = 0; i < outLen; i++) {
    let sum = 0;
    for (let j = 0; j < ratio; j++) {
      sum += pcm24k[i * ratio + j];
    }
    mulawOut[i] = mulaw.encode(Math.round(sum / ratio));
  }

  return mulawOut;
}
