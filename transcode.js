import { mulaw } from 'alawmulaw';
export function mulawToPcm16(mulawBuffer) {
  const samples = mulaw.decode(mulawBuffer);
  return Buffer.from(samples.buffer);
}
export function pcm16ToMulaw(pcmBuffer) {
  const int16 = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
  const encoded = mulaw.encode(int16);
  return Buffer.from(encoded);
}
