/** Why a host child conversation tab cannot show its conversation. */
export function HostChildFailure({ error }: { readonly error: Error }) {
  return (
    <div className="p-4 text-destructive" role="alert">
      {error.message}
    </div>
  );
}
