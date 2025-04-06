import type { IFileNode } from "@brainstrike/types";
import { generateProjectTreeText } from "../folder-tree-generator";

const createMockFileHandle = (): FileSystemFileHandle => ({
  kind: "file",
  name: "",
  getFile: async () => new File([], ""),
  isSameEntry: async () => true,
  createWritable: async () => {
    throw new Error("Not implemented in tests");
  },
});

const createMockDirHandle = (): FileSystemDirectoryHandle => ({
  kind: "directory",
  name: "",
  getDirectoryHandle: async () => ({} as FileSystemDirectoryHandle),
  getFileHandle: async () => ({} as FileSystemFileHandle),
  removeEntry: async () => {},
  resolve: async () => [],
  entries: async function* () {},
  isSameEntry: async () => true,
});

const createMockFile = (path: string, name: string): IFileNode => ({
  path,
  name,
  type: "file",
  handle: createMockFileHandle(),
  depth: path.split("/").length - 1,
  selectionState: "unchecked",
  children: [],
  rootFolderId: "test-folder",
});

const createMockDir = (path: string, name: string): IFileNode => ({
  path,
  name,
  type: "directory",
  handle: createMockDirHandle(),
  depth: path.split("/").length - 1,
  selectionState: "unchecked",
  children: [],
  rootFolderId: "test-folder",
});

describe("generateProjectTreeText", () => {
  it("generates tree text with folder summary threshold", () => {
    const rootDir = createMockDir("root", "root");
    const srcDir = createMockDir("root/src", "src");
    const files = Array.from({ length: 10 }, (_, i) =>
      createMockFile(`root/src/file${i}.ts`, `file${i}.ts`)
    );

    srcDir.children = files;
    rootDir.children = [srcDir];

    const result = generateProjectTreeText([rootDir], [], [], false, 3);

    expect(result).toContain("file0.ts");
    expect(result).toContain("file1.ts");
    expect(result).toContain("file2.ts");
    expect(result).toContain("... 7 more items");
  });

  it("generates full tree when threshold is 0", () => {
    const rootDir = createMockDir("root", "root");
    const srcDir = createMockDir("root/src", "src");
    const files = Array.from({ length: 10 }, (_, i) =>
      createMockFile(`root/src/file${i}.ts`, `file${i}.ts`)
    );

    srcDir.children = files;
    rootDir.children = [srcDir];

    const result = generateProjectTreeText([rootDir], [], [], false, 0);

    for (let i = 0; i < 10; i++) {
      expect(result).toContain(`file${i}.ts`);
    }
    expect(result).not.toContain("... more items");
  });

  it("applies include filters", () => {
    const rootDir = createMockDir("root", "root");
    const srcDir = createMockDir("root/src", "src");
    const files = Array.from({ length: 10 }, (_, i) =>
      createMockFile(`root/src/file${i}.ts`, `file${i}.ts`)
    );

    srcDir.children = files;
    rootDir.children = [srcDir];

    const result = generateProjectTreeText(
      [rootDir],
      ["**/file[0-4].ts"],
      [],
      false,
      0
    );

    expect(result).toContain("file0.ts");
    expect(result).toContain("file4.ts");
    expect(result).not.toContain("file5.ts");
  });

  it("handles paths with leading slashes", () => {
    const rootDir = createMockDir("/root", "root");
    const testFile = createMockFile("/root/test.ts", "test.ts");
    rootDir.children = [testFile];

    const result = generateProjectTreeText([rootDir], [], [], false, 0);
    expect(result).toContain("test.ts");
  });

  it("sorts files and directories correctly", () => {
    const rootDir = createMockDir("root", "root");
    const dirA = createMockDir("root/a", "a");
    const fileB = createMockFile("root/b.ts", "b.ts");
    const fileA = createMockFile("root/a.ts", "a.ts");

    rootDir.children = [fileB, dirA, fileA];

    const result = generateProjectTreeText([rootDir], [], [], false, 0);
    const lines = result.split("\n");

    expect(lines.findIndex((l) => l.includes("a/"))).toBeLessThan(
      lines.findIndex((l) => l.includes("a.ts"))
    );
    expect(lines.findIndex((l) => l.includes("a.ts"))).toBeLessThan(
      lines.findIndex((l) => l.includes("b.ts"))
    );
  });
});

describe("folderTreeGenerator pattern matching", () => {
  it("should handle regex patterns correctly", () => {
    const srcDir = createMockDir("src", "src");
    const componentsDir = createMockDir("src/components", "components");
    const utilsDir = createMockDir("src/utils", "utils");

    const buttonFile = createMockFile(
      "src/components/Button.tsx",
      "Button.tsx"
    );
    const inputFile = createMockFile("src/components/Input.tsx", "Input.tsx");
    const helperFile = createMockFile("src/utils/helper.ts", "helper.ts");

    componentsDir.children = [buttonFile, inputFile];
    utilsDir.children = [helperFile];
    srcDir.children = [componentsDir, utilsDir];

    const result = generateProjectTreeText([srcDir], ["\\.tsx$"], [], true, 0);

    expect(result).toContain("Button.tsx");
    expect(result).toContain("Input.tsx");
    expect(result).not.toContain("helper.ts");
  });

  it("should handle glob patterns correctly", () => {
    const srcDir = createMockDir("src", "src");
    const componentsDir = createMockDir("src/components", "components");
    const utilsDir = createMockDir("src/utils", "utils");

    const buttonFile = createMockFile(
      "src/components/Button.tsx",
      "Button.tsx"
    );
    const inputFile = createMockFile("src/components/Input.tsx", "Input.tsx");
    const helperFile = createMockFile("src/utils/helper.ts", "helper.ts");

    componentsDir.children = [buttonFile, inputFile];
    utilsDir.children = [helperFile];
    srcDir.children = [componentsDir, utilsDir];

    const result = generateProjectTreeText(
      [srcDir],
      ["**/*.tsx"],
      [],
      false,
      0
    );

    expect(result).toContain("Button.tsx");
    expect(result).toContain("Input.tsx");
    expect(result).not.toContain("helper.ts");
  });
});
