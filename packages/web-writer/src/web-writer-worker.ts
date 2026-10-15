/** The web app's state writer worker: the state DB, with the derived index beside it. */
import { startWebStateWorker } from '@brainstrike/web-state-store/writer';
import { derivedIndexExtension } from './derived-index-extension';

startWebStateWorker([derivedIndexExtension]);
