import { describe, expect, it } from 'vitest';
import { getFileExtension } from '../file-utils';

describe('getFileExtension', () => {
  it('returns empty string for empty input', () => {
    expect(getFileExtension('')).toBe('');
  });

  it('returns extension for simple filename', () => {
    expect(getFileExtension('file.txt')).toBe('txt');
    expect(getFileExtension('image.png')).toBe('png');
  });

  it('returns lowercased extension', () => {
    expect(getFileExtension('FILE.TXT')).toBe('txt');
    expect(getFileExtension('Image.PNG')).toBe('png');
  });

  it('returns empty string when no extension', () => {
    expect(getFileExtension('file')).toBe('');
    expect(getFileExtension('README')).toBe('');
  });

  it('returns extension for file with multiple dots', () => {
    expect(getFileExtension('archive.tar.gz')).toBe('gz');
    expect(getFileExtension('backup.2023.01.01.zip')).toBe('zip');
  });

  it('returns empty string for hidden files (dotfiles) with no extension', () => {
    expect(getFileExtension('.gitignore')).toBe('');
    expect(getFileExtension('.env')).toBe('');
    expect(getFileExtension('.config')).toBe('');
  });

  it('returns extension for hidden files with extension', () => {
    expect(getFileExtension('.env.local')).toBe('local');
    expect(getFileExtension('.eslintrc.json')).toBe('json');
  });

  it('handles paths with forward slashes', () => {
    expect(getFileExtension('path/to/file.txt')).toBe('txt');
    expect(getFileExtension('/absolute/path/to/image.jpeg')).toBe('jpeg');
    expect(getFileExtension('folder/file')).toBe('');
    expect(getFileExtension('folder/.config')).toBe('');
    expect(getFileExtension('folder/.env.local')).toBe('local');
  });

  it('handles paths with backslashes (Windows)', () => {
    expect(getFileExtension('path\\to\\file.txt')).toBe('txt');
    expect(getFileExtension('C:\\Windows\\System32\\driver.sys')).toBe('sys');
    expect(getFileExtension('folder\\file')).toBe('');
    expect(getFileExtension('folder\\.config')).toBe('');
    expect(getFileExtension('folder\\.env.local')).toBe('local');
  });

  it('handles mixed separators', () => {
    expect(getFileExtension('path/to\\file.txt')).toBe('txt');
  });

  it('handles edge cases with dots and separators', () => {
    expect(getFileExtension('path/to/file.')).toBe(''); // trailing dot
    expect(getFileExtension('path/to/..')).toBe(''); // parent directory reference
    expect(getFileExtension('path/to/.')).toBe(''); // current directory reference
    expect(getFileExtension('/.')).toBe('');
    expect(getFileExtension('/..')).toBe('');
  });

  it('handles dots in directory names', () => {
    expect(getFileExtension('path.to/file')).toBe('');
    expect(getFileExtension('/var/www/site.com/index.html')).toBe('html');
  });
});
