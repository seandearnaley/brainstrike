import { createHash } from 'node:crypto';
import { DELEGATED_CONVERSATION_COLOR_IDS, type DelegatedConversationColor } from '@brainstrike/db';

const DISPLAY_NAMES = [
  'Cedar',
  'Fern',
  'Aspen',
  'Maple',
  'Iris',
  'Willow',
  'Birch',
  'Alder',
  'Hazel',
  'Juniper',
  'Cypress',
  'Rowan',
  'Kestrel',
  'Falcon',
  'Heron',
  'Moth',
  'Lynx',
  'Otter',
  'Orbit',
  'Comet',
  'Nova',
  'Vector',
  'Pixel',
  'Circuit',
  'Flint',
  'Onyx',
  'Quartz',
  'Opal',
  'Ember',
  'Sable',
  'Drift',
  'Echo',
  'Pulse',
  'Tempo',
  'Signal',
  'Riff',
  'Nimbus',
  'Solstice',
  'Vesper',
  'Helix',
  'Prism',
  'Zenith',
  'Beacon',
  'Radar',
  'Volt',
  'Chroma',
  'Moss',
  'Delta',
] as const;

/** Display identity only: never derive ownership or ancestry from a native id. */
export function createDelegatedDisplayIdentity(threadId: string): {
  color: DelegatedConversationColor;
  displayName: string;
} {
  const digest = createHash('sha256').update(threadId).digest();
  const name = DISPLAY_NAMES[digest.readUInt16BE(0) % DISPLAY_NAMES.length];
  const color =
    DELEGATED_CONVERSATION_COLOR_IDS[
      digest.readUInt16BE(2) % DELEGATED_CONVERSATION_COLOR_IDS.length
    ];
  if (!(name && color)) {
    throw new Error('Delegated conversation display palette is empty.');
  }
  return { color, displayName: `${name}-${digest.toString('hex').slice(0, 6)}` };
}
