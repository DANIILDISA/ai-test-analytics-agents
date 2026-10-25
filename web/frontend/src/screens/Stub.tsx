// web/frontend/src/screens/Stub.tsx
export function Stub({ title }: { title: string }) {
  return (
    <div className="p-8">
      <h1 className="text-xl font-bold">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">Экран в разработке. Появится в следующем спринте.</p>
    </div>
  );
}
