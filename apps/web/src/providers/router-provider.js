import { jsx as _jsx } from "react/jsx-runtime";
import { BrowserRouter } from 'react-router-dom';
export default function RouterProvider({ children }) {
    return _jsx(BrowserRouter, { children: children });
}
