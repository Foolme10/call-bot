// Compliance notice shown wherever users write SMS content (composer + template
// editor). MCMC (Malaysia) blocks URLs and phone numbers in the message body.
export default function SmsNotice() {
  return (
    <div
      className="alert"
      style={{
        background: 'rgba(210,153,34,.12)',
        color: '#e3b341',
        border: '1px solid rgba(210,153,34,.3)',
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <strong>Important Notice — SMS Content Restrictions (Malaysia)</strong>
      <p style={{ margin: '8px 0 0' }}>
        In compliance with MCMC (Malaysian Communications and Multimedia Commission) regulations,
        telco networks in Malaysia block SMS messages containing URLs/links and phone numbers in the
        message body.
      </p>
      <p style={{ margin: '8px 0 0' }}>
        Embedding of URLs and any attempt to circumvent the blocking of phone numbers (e.g.,
        obfuscated links, spaced-out or reformatted numbers) is not supported.
      </p>
      <p style={{ margin: '8px 0 0', fontWeight: 700 }}>
        Please note: if such content is sent, the SMS will still be chargeable even if it is blocked
        or not delivered to the recipient.
      </p>
      <p style={{ margin: '8px 0 0' }}>
        Please ensure your message content is free of URLs and phone numbers before sending.
      </p>
    </div>
  );
}
