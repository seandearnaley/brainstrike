import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from './toast';
import { useToast } from './use-toast';

export function Toaster() {
  const { toasts } = useToast();

  return (
    <ToastProvider>
      {toasts.map(({ id, title, description, action, persistent, ...props }) => (
        // `persistent` is the store's option, not a Radix prop: it is
        // translated here into an infinite Radix `duration` so the provider's
        // 5s default can never close the toast (see the DURATION SEMANTICS
        // note in use-toast.ts — Radix skips its close timer entirely for
        // `Infinity`). Non-persistent toasts keep their own `duration` (or
        // the provider default) via the props spread.
        <Toast key={id} {...props} {...(persistent ? { duration: Number.POSITIVE_INFINITY } : {})}>
          <div className="grid gap-1">
            {title && <ToastTitle>{title}</ToastTitle>}
            {description && <ToastDescription>{description}</ToastDescription>}
          </div>
          {action}
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}
