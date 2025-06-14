export interface FileRecord {
  id: string; // UUID
  name: string;
  path: string;
  size: number;
  createdAt: string; // ISO date string
  updatedAt: string; // ISO date string
}
