import { Badge } from '@brainstrike/ui';

export function StylingTest() {
  return (
    <div className="p-8 space-y-4">
      <h2 className="text-2xl font-bold">Styling Test</h2>

      {/* Original Badge */}
      <div>
        <h3 className="text-lg font-medium mb-2">Original Badge</h3>
        <Badge>Default Badge</Badge>
        <Badge variant="secondary" className="ml-2">
          Secondary Badge
        </Badge>
        <Badge variant="destructive" className="ml-2">
          Destructive Badge
        </Badge>
        <Badge variant="outline" className="ml-2">
          Outline Badge
        </Badge>
      </div>

      {/* Direct Tailwind Classes */}
      <div>
        <h3 className="text-lg font-medium mb-2">Direct Tailwind Classes</h3>
        <div className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold border-transparent bg-primary text-primary-foreground">
          Manual Tailwind
        </div>
        <div className="ml-2 inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold border-transparent bg-secondary text-secondary-foreground">
          Manual Secondary
        </div>
      </div>

      {/* Basic Utility Classes Test */}
      <div>
        <h3 className="text-lg font-medium mb-2">Basic Tailwind Utilities</h3>
        <div className="bg-red-500 text-white p-4 m-2 rounded-md">
          Red Background with Padding 4
        </div>
        <div className="bg-blue-500 text-white px-8 py-2 m-2 rounded-md">
          Blue Background with Padding X-8 Y-2
        </div>
      </div>

      {/* Spacing Test */}
      <div className="flex items-center">
        <div className="w-16 h-16 bg-green-500 mr-4" />
        <div className="w-16 h-16 bg-yellow-500 mr-4" />
        <div className="w-16 h-16 bg-purple-500" />
      </div>
    </div>
  );
}
