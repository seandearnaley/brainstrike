import type React from 'react';
import { createContext, useContext } from 'react';

export interface FileEditorContextValue {
  openFileInTab: (compositeKey: string) => void;
}

const FileEditorContext = createContext<FileEditorContextValue | null>(null);

export interface FileEditorProviderProps {
  children: React.ReactNode;
  value: FileEditorContextValue;
}

export const FileEditorProvider = ({ children, value }: FileEditorProviderProps) => (
  <FileEditorContext.Provider value={value}>{children}</FileEditorContext.Provider>
);

export const useFileEditor = (): FileEditorContextValue => {
  const context = useContext(FileEditorContext);
  if (!context) {
    throw new Error('useFileEditor must be used within a FileEditorProvider');
  }
  return context;
};
