declare global {
  namespace NodeJS {
    type ProcessEnv = {
      readonly NODE_ENV?: 'development' | 'production' | 'test';
      readonly PORT?: string;
    };
  }
}

export {};
