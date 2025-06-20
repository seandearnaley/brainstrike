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
import { FileText, Layers, Search, Settings } from 'lucide-react';

export function RightPanel() {
  return (
    <div className="h-full flex flex-col">
      <Tabs defaultValue="properties" className="flex-1 flex flex-col">
        <TabsList className="grid grid-cols-4 mx-2 mt-2 mb-2">
          <TabsTrigger value="properties" className="flex items-center gap-1">
            <FileText className="h-3 w-3" />
            <span className="hidden sm:inline">Props</span>
          </TabsTrigger>
          <TabsTrigger value="layers" className="flex items-center gap-1">
            <Layers className="h-3 w-3" />
            <span className="hidden sm:inline">Layers</span>
          </TabsTrigger>
          <TabsTrigger value="search" className="flex items-center gap-1">
            <Search className="h-3 w-3" />
            <span className="hidden sm:inline">Search</span>
          </TabsTrigger>
          <TabsTrigger value="settings" className="flex items-center gap-1">
            <Settings className="h-3 w-3" />
            <span className="hidden sm:inline">Config</span>
          </TabsTrigger>
        </TabsList>

        <div className="flex-1 px-2 pb-2">
          <TabsContent value="properties" className="h-full mt-0">
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

          <TabsContent value="layers" className="h-full mt-0">
            <Card className="h-full">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Layers</CardTitle>
                <CardDescription className="text-xs">
                  Layer hierarchy and organization
                </CardDescription>
              </CardHeader>
              <CardContent className="text-xs space-y-3">
                <div>
                  <h4 className="font-medium mb-2">Layer Structure</h4>
                  <p className="text-muted-foreground leading-relaxed">
                    Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium
                    doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore
                    veritatis et quasi architecto beatae vitae dicta sunt.
                  </p>
                </div>
                <div>
                  <h4 className="font-medium mb-2">Layer Controls</h4>
                  <p className="text-muted-foreground leading-relaxed">
                    Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed
                    quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt.
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="search" className="h-full mt-0">
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

          <TabsContent value="settings" className="h-full mt-0">
            <Card className="h-full">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Configuration</CardTitle>
                <CardDescription className="text-xs">
                  Application settings and preferences
                </CardDescription>
              </CardHeader>
              <CardContent className="text-xs space-y-3">
                <div>
                  <h4 className="font-medium mb-2">General Settings</h4>
                  <p className="text-muted-foreground leading-relaxed">
                    At vero eos et accusamus et iusto odio dignissimos ducimus qui blanditiis
                    praesentium voluptatum deleniti atque corrupti quos dolores et quas molestias
                    excepturi sint occaecati cupiditate non provident.
                  </p>
                </div>
                <div>
                  <h4 className="font-medium mb-2">Advanced Options</h4>
                  <p className="text-muted-foreground leading-relaxed">
                    Similique sunt in culpa qui officia deserunt mollitia animi, id est laborum et
                    dolorum fuga. Et harum quidem rerum facilis est et expedita distinctio.
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
