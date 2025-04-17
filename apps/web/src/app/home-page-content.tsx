import ClientFileExplorer from '../components/custom/client-file-explorer';
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
