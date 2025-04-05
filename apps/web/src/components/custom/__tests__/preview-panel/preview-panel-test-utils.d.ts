import { screen } from '@testing-library/react';
import type { ReactElement } from 'react';
declare const userEvent: {
    setup: (options?: {}) => import("@testing-library/user-event").UserEvent;
    clear: typeof import("@testing-library/user-event/dist/cjs/setup/directApi.js").clear;
    click: typeof import("@testing-library/user-event/dist/cjs/setup/directApi.js").click;
    copy: typeof import("@testing-library/user-event/dist/cjs/setup/directApi.js").copy;
    cut: typeof import("@testing-library/user-event/dist/cjs/setup/directApi.js").cut;
    dblClick: typeof import("@testing-library/user-event/dist/cjs/setup/directApi.js").dblClick;
    deselectOptions: typeof import("@testing-library/user-event/dist/cjs/setup/directApi.js").deselectOptions;
    hover: typeof import("@testing-library/user-event/dist/cjs/setup/directApi.js").hover;
    keyboard: typeof import("@testing-library/user-event/dist/cjs/setup/directApi.js").keyboard;
    pointer: typeof import("@testing-library/user-event/dist/cjs/setup/directApi.js").pointer;
    paste: typeof import("@testing-library/user-event/dist/cjs/setup/directApi.js").paste;
    selectOptions: typeof import("@testing-library/user-event/dist/cjs/setup/directApi.js").selectOptions;
    tripleClick: typeof import("@testing-library/user-event/dist/cjs/setup/directApi.js").tripleClick;
    type: typeof import("@testing-library/user-event/dist/cjs/setup/directApi.js").type;
    unhover: typeof import("@testing-library/user-event/dist/cjs/setup/directApi.js").unhover;
    upload: typeof import("@testing-library/user-event/dist/cjs/setup/directApi.js").upload;
    tab: typeof import("@testing-library/user-event/dist/cjs/setup/directApi.js").tab;
};
export declare const TEST_FOLDER_ID = "test-folder";
export declare function createCompositeKey(path: string): string;
export declare const mockOnSelectionChange: import("vitest").Mock<(...args: any[]) => any>;
export declare const mockOnLoadFileContent: import("vitest").Mock<(...args: any[]) => any>;
export declare const defaultProps: {
    selectedFiles: Set<string>;
    onSelectionChange: import("vitest").Mock<(...args: any[]) => any>;
    fileContents: {};
    loadingFiles: Set<string>;
    onLoadFileContent: import("vitest").Mock<(...args: any[]) => any>;
    fileSizes: {};
};
declare function render(ui: ReactElement): import("@testing-library/react").RenderResult<typeof import("@testing-library/dom/types/queries"), HTMLElement, HTMLElement>;
export { render, screen, userEvent };
//# sourceMappingURL=preview-panel-test-utils.d.ts.map