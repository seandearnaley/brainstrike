import { repositoryRetrievalFixtureSchema } from '../repository-retrieval';
import data from './repository-retrieval.json';

export const repositoryRetrievalFixture = repositoryRetrievalFixtureSchema.parse(data);
