import React from 'react';
import ClientFileExplorer from '../components/custom/client-file-explorer';

export default function HomePageContent() {
  return (
    <>
      <title>BrainStrike.ai - Home</title>
      <meta name="description" content="BrainStrike.ai Home Dashboard" />
      <ClientFileExplorer />
    </>
  );
}
