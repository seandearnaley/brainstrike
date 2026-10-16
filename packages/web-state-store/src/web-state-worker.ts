/**
 * The state writer worker with nothing composed beside the state DB. A host
 * that composes extensions has its own entry calling `startWebStateWorker`.
 */
import { startWebStateWorker } from './web-state-writer';

startWebStateWorker();
