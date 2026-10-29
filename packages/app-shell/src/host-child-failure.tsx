/** Why a host child conversation tab cannot show its conversation. */
export function HostChildFailure({ error }: { readonly error: Error }) {
  return (
    <div className="text-destructive p-4" role="alert">
      {error.message}
    </div>
  );
}
