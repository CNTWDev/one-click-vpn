export default function Home() {
  return (
    <main className="api-root">
      <h1>Northstar Control Plane</h1>
      <p>This host serves the Northstar API. Use the admin console or the user portal to manage the service.</p>
      <p><a href="/api/v1/health">API health</a></p>
    </main>
  );
}
