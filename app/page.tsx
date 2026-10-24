export default function Home() {
  return (
    <main className="api-root">
      <h1>TrackNothing Control Plane</h1>
      <p>This host serves the TrackNothing API. Use the admin console or the user portal to manage the service.</p>
      <p><a href="/api/v1/health">API health</a></p>
    </main>
  );
}
