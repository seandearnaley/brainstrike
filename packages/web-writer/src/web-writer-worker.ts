/**
 * The web app's state writer worker: the state DB, with the derived index
 * beside it and the file index in a worker of its own.
 */
import { startWebStateWorker } from '@brainstrike/web-state-store/writer';
import { derivedIndexExtension } from './derived-index-extension';
import { fileIndexExtension } from './file-index-extension';

startWebStateWorker([derivedIndexExtension, fileIndexExtension]);
