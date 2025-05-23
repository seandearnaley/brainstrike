import { ClientFileExplorer } from '@brainstrike/file-explorer-ui';
import { Helmet } from 'react-helmet-async';

export default function HomePageContent() {
  return (
    <>
      <Helmet>
        <title>BrainStrike.ai - Home</title>
        <meta name="description" content="BrainStrike.ai Home Dashboard" />
      </Helmet>
      <ClientFileExplorer />
    </>
  );
}
