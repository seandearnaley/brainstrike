import { calcArea } from './geometry.ts';

export interface Room {
  readonly depth: number;
  readonly name: string;
  readonly width: number;
}

/** One line per room: its name and floor area. */
export function floorReport(rooms: readonly Room[]): string {
  return rooms.map((room) => `${room.name}: ${calcArea(room.width, room.depth)} m2`).join('\n');
}
