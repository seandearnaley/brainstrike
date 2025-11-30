import type React from 'react';
import { createContext, useContext } from 'react';

export type FileEditorContextValue = {
  openFileInTab: (compositeKey: string) => void;
};

const FileEditorContext = createContext<FileEditorContextValue | null>(null);

export type FileEditorProviderProps = {
  children: React.ReactNode;
  value: FileEditorContextValue;
};

export const FileEditorProvider: React.FC<FileEditorProviderProps> = ({ children, value }) => (
  <FileEditorContext.Provider value={value}>{children}</FileEditorContext.Provider>
);

export const useFileEditor = (): FileEditorContextValue => {
  const context = useContext(FileEditorContext);
  if (!context) {
    throw new Error('useFileEditor must be used within a FileEditorProvider');
  }
  return context;
};
