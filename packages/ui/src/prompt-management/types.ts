export interface Prompt {
  categoryId: string;
  content: string;
  createdAt: number;
  id: string;
  isFavorite: boolean;
  modelSettings: {
    model: string;
    temperature: number;
    topP: number;
    maxTokens?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
  };
  rating: number; // 1-5
  revisions: PromptRevision[];
  site?: string; // URL association
  tags: string[];
  title: string;
  updatedAt: number;
}

export interface PromptRevision {
  content: string;
  id: string;
  modelSettings?: Prompt['modelSettings'];
  note?: string;
  timestamp: number;
}

export interface Category {
  color: string;
  description?: string;
  icon: string;
  id: string;
  name: string;
}

export interface ModelOption {
  id: string;
  name: string;
  providerId: string;
}

export interface PromptFilter {
  categoryId?: string | null;
  favoritesOnly: boolean;
  rating?: number;
  search: string;
  tags: string[];
}
