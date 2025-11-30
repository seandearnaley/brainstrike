export type Prompt = {
  id: string;
  title: string;
  content: string;
  categoryId: string;
  tags: string[];
  modelSettings: {
    model: string;
    temperature: number;
    topP: number;
    maxTokens?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
  };
  revisions: PromptRevision[];
  rating: number; // 1-5
  site?: string; // URL association
  isFavorite: boolean;
  createdAt: number;
  updatedAt: number;
};

export type PromptRevision = {
  id: string;
  content: string;
  timestamp: number;
  note?: string;
  modelSettings?: Prompt['modelSettings'];
};

export type Category = {
  id: string;
  name: string;
  color: string;
  icon: string;
  description?: string;
};

export type ModelOption = {
  id: string;
  name: string;
  providerId: string;
};

export type PromptFilter = {
  search: string;
  categoryId?: string | null;
  tags: string[];
  rating?: number;
  favoritesOnly: boolean;
};
