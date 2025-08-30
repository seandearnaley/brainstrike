import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@brainstrike/ui';
import { Brain, Database, FileText, Search } from 'lucide-react';
import { DatabaseDemoPanel } from './database-demo-panel';
import { EmbeddingsPanel } from './embeddings-panel';
import { QueueHud } from './queue-hud';

export function RightPanel() {
  return (
    <div className="h-full flex flex-col">
      <Tabs defaultValue="properties" className="flex-1 flex flex-col">
        <TabsList className="grid grid-cols-4 mx-2 mt-2 mb-2 flex-shrink-0">
          <TabsTrigger value="properties" className="flex items-center gap-1">
            <FileText className="h-3 w-3" />
            <span className="hidden sm:inline">Props</span>
          </TabsTrigger>
          <TabsTrigger value="embeddings" className="flex items-center gap-1">
            <Brain className="h-3 w-3" />
            <span className="hidden sm:inline">Embed</span>
          </TabsTrigger>
          <TabsTrigger value="search" className="flex items-center gap-1">
            <Search className="h-3 w-3" />
            <span className="hidden sm:inline">Search</span>
          </TabsTrigger>
          <TabsTrigger value="database" className="flex items-center gap-1">
            <Database className="h-3 w-3" />
            <span className="hidden sm:inline">DB</span>
          </TabsTrigger>
        </TabsList>

        <div className="flex-1 px-2 pb-2 flex flex-col min-h-0">
          <TabsContent value="properties" className="flex-1 mt-0 overflow-y-auto min-h-0">
            <Card className="h-full">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Properties</CardTitle>
                <CardDescription className="text-xs">
                  Element properties and attributes
                </CardDescription>
              </CardHeader>
              <CardContent className="text-xs space-y-3">
                <div>
                  <h4 className="font-medium mb-2">Basic Properties</h4>
                  <p className="text-muted-foreground leading-relaxed">
                    Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
                    incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis
                    nostrud exercitation ullamco laboris.
                  </p>
                </div>
                <div>
                  <h4 className="font-medium mb-2">Advanced Settings</h4>
                  <p className="text-muted-foreground leading-relaxed">
                    Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu
                    fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in
                    culpa qui officia deserunt mollit anim id est laborum.
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="embeddings" className="flex-1 mt-0 overflow-y-auto min-h-0">
            <EmbeddingsPanel />
          </TabsContent>

          <TabsContent value="search" className="flex-1 mt-0 overflow-y-auto min-h-0">
            <Card className="h-full">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Search</CardTitle>
                <CardDescription className="text-xs">
                  Search and replace functionality
                </CardDescription>
              </CardHeader>
              <CardContent className="text-xs space-y-3">
                <div>
                  <h4 className="font-medium mb-2">Search Options</h4>
                  <p className="text-muted-foreground leading-relaxed">
                    Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet, consectetur,
                    adipisci velit, sed quia non numquam eius modi tempora incidunt ut labore et
                    dolore magnam aliquam quaerat voluptatem.
                  </p>
                </div>
                <div>
                  <h4 className="font-medium mb-2">Replace Functions</h4>
                  <p className="text-muted-foreground leading-relaxed">
                    Ut enim ad minima veniam, quis nostrum exercitationem ullam corporis suscipit
                    laboriosam, nisi ut aliquid ex ea commodi consequatur.
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="database" className="flex-1 mt-0 overflow-y-auto min-h-0">
            <div className="space-y-2">
              <QueueHud />
              <DatabaseDemoPanel />
            </div>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
