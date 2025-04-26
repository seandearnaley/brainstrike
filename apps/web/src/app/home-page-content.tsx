import { Helmet } from 'react-helmet-async';
import ClientFileExplorer from '../components/custom/client-file-explorer';

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
