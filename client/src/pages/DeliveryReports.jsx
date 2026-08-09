// Placeholder for the upcoming SMS delivery-report (DLR) screen. Every sent
// message already stores its gateway message ID; this screen will match the
// gateway's delivery receipts back to it and show per-recipient delivery status.
export default function DeliveryReports() {
  return (
    <div>
      <div className="page-head">
        <h2>Delivery Reports</h2>
        <span className="badge info">Coming soon</span>
      </div>

      <section className="card" style={{ textAlign: 'center', padding: '48px 24px' }}>
        <div style={{ fontSize: 44, marginBottom: 12 }}>📬</div>
        <h3 style={{ marginBottom: 8 }}>Delivery reporting is on the way</h3>
        <p className="muted" style={{ maxWidth: 560, margin: '0 auto' }}>
          This screen will show the <strong>delivery status of each SMS</strong> — whether it
          actually reached the recipient’s handset — using the delivery receipts (DLR) returned by
          the SMS gateway.
        </p>
        <p className="muted small" style={{ maxWidth: 560, margin: '12px auto 0' }}>
          Every message already stores its gateway message ID when it’s sent, so once delivery
          receipts are wired up, each recipient will show <strong>Delivered</strong>,{' '}
          <strong>Failed</strong>, or <strong>Pending</strong> here — separate from the “Sent”
          (accepted by the gateway) status you see in Reports today.
        </p>
      </section>
    </div>
  );
}
