import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { repositoryRetrievalFixtureSchema } from '../repository-retrieval';
import data from './repository-retrieval.json';

export const repositoryRetrievalFixture = wireDecoder(repositoryRetrievalFixtureSchema, {
  errors: 'all',
})(data);
