# Go Backend for React Native Mobile SMS OTP: Auditable Autofill and Abuse Controls

A defensible contact-form design uses an opaque, single-use backend challenge before a request can enter a privileged support queue; SMS autofill remains an input convenience, never proof of identity. **TL;DR:** expiry, attempt limits, repeat-send timing, consumption, and the audit trail are server state. The mobile client submits a challenge identifier and a user-entered or autofilled code without deciding whether either is still valid.

The deciding constraint is compliance evidence. A support team must be able to show why a request reached the account-access queue without retaining the OTP itself, while an on-call engineer needs bounded traffic when one phone number, device, or network starts hammering resend. SMS delivery is outside the application's failure domain, so a design that equates “message accepted upstream” with “user verified” produces the wrong evidence and the wrong SLO.

This is also not a claim that SMS is phishing-resistant. NIST describes use of the public switched telephone network for out-of-band authentication as restricted and requires consideration of risks such as SIM changes and number porting [1]. For a contact form, successful SMS verification can support a routing decision; it should not silently become authorization for changing credentials, exporting data, or bypassing account recovery controls.

## What must the evidence prove?

Evidence first.

Start with an explicit routing rule: ordinary product questions may enter the general queue without a verified phone number, but a form claiming account ownership enters the account-access queue only after a live challenge is consumed. Record the policy version with the decision. Otherwise, six months later an audit row can say `verified` while nobody can reconstruct what that status permitted at the time. The useful record is small: a random challenge ID, a keyed digest or one-way verifier for the code, normalized destination metadata with tightly controlled access, creation and expiry times, counters for sends and failed checks, a consumed timestamp, the policy version, and a correlation ID carried into the support ticket. Do not log the code, message body, or full phone number. OWASP recommends that authentication responses avoid exposing whether an account exists, and it also calls out login throttling and account lockout considerations [2]; those principles apply at both the request and verify steps. Evidence needs a negative path too. A rejected form should state a machine-readable reason such as expired, consumed, attempts exhausted, or rate limited in the restricted audit stream, while the public response remains coarse enough to resist enumeration. Keep application logs operational and the audit ledger access-controlled; copying sensitive fields into every trace is not observability.

**Set two separate objectives.** The verification service can own an availability and latency SLO for challenge creation and checking. It cannot honestly own carrier delivery time end to end. Track provider acceptance, delivery receipts where they exist, verification completion, and user abandonment as different signals, with error-budget policy attached only to the portions the platform can control.

## Detect request amplification before it threatens the service

The obvious signal is a high request count. The more revealing pattern is fan-out: many destinations from one device or network, or one destination targeted through many devices. A per-phone timer in the mobile UI catches neither pattern because a modified client can ignore it. It also fails open after reinstall.

Use layered server-side limits over destination, account when known, device installation, network prefix, and a global send budget. The exact thresholds are policy, not universal constants. Choose them from expected login volume, false-positive tolerance, carrier throughput, and the number of engineers willing to be paged. Capacity planning belongs here: estimate peak legitimate challenge starts, multiply by the retry distribution observed in testing, reserve headroom for recovery traffic, and cap outbound work below the point where the queue's age violates its SLO.

Resend should usually reuse the active challenge while rotating or invalidating any previously issued code according to one documented rule. Ambiguous behavior is dangerous: if two texts contain two apparently valid codes, users retry the older one, inflate failure counters, and train support staff to override controls. Return `202 Accepted` for an eligible request only after durable work has been queued; use the same neutral response when disclosure would reveal whether a destination maps to an account. `Retry-After` is the standard response header for telling a client when another attempt may be made [3].

Short spikes happen. A sustained rise in sends per completed verification, destination fan-out, failed checks per challenge, queue age, or delivery-receipt lag deserves investigation. Page on user-visible SLO risk, not on every rejected attacker request; rejection is the limiter doing its job.

## How should a React Native mobile app handle SMS OTP autofill?

The backend needs two public operations for this flow: request a challenge and verify it. The contact-form submission can then reference a consumed verification result through an internal transaction. Do not let the client select the support queue directly.

The client is not trusted.

The following Go sketch focuses on the state transition. It deliberately leaves SMS transport behind an interface, uses a cryptographically random six-digit code, stores only an HMAC, serializes updates through a repository method, and consumes a challenge exactly once. In production, `Update` must provide a transaction or compare-and-swap guarantee; a process-local mutex does not protect multiple replicas.

```go
package otp

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

var ErrInvalidChallenge = errors.New("challenge is unavailable")

type Challenge struct {
	ID         string
	Phone      string
	CodeMAC    string
	ExpiresAt  time.Time
	Attempts   int
	MaxAttempts int
	ConsumedAt *time.Time
	Policy     string
}

type Repository interface {
	Insert(context.Context, Challenge) error
	Update(context.Context, string, func(*Challenge) error) error
}

type Sender interface {
	SendCode(context.Context, string, string) error
}

type Service struct {
	Repo   Repository
	Sender Sender
	MACKey []byte
	Now    func() time.Time
}

func generateCode() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", binary.BigEndian.Uint64(b[:])%1_000_000), nil
}

func (s Service) mac(challengeID, code string) string {
	h := hmac.New(sha256.New, s.MACKey)
	h.Write([]byte(challengeID))
	h.Write([]byte{0})
	h.Write([]byte(code))
	return hex.EncodeToString(h.Sum(nil))
}

func (s Service) Start(ctx context.Context, id, phone string) error {
	code, err := generateCode()
	if err != nil {
		return err
	}
	now := s.Now()
	c := Challenge{
		ID: id, Phone: phone, CodeMAC: s.mac(id, code),
		ExpiresAt: now.Add(5 * time.Minute), MaxAttempts: 5,
		Policy: "support-routing-v1",
	}
	if err := s.Repo.Insert(ctx, c); err != nil {
		return err
	}
	return s.Sender.SendCode(ctx, phone, code)
}

func (s Service) Verify(ctx context.Context, id, code string) error {
	return s.Repo.Update(ctx, id, func(c *Challenge) error {
		now := s.Now()
		if c.ConsumedAt != nil || !now.Before(c.ExpiresAt) || c.Attempts >= c.MaxAttempts {
			return ErrInvalidChallenge
		}
		c.Attempts++
		provided := s.mac(c.ID, code)
		if !hmac.Equal([]byte(provided), []byte(c.CodeMAC)) {
			return ErrInvalidChallenge
		}
		c.ConsumedAt = &now
		return nil
	})
}
```

Five minutes and five attempts are example policy values in this sketch, not claims about an industry optimum. They must be configurable, reviewed, and covered by tests. The random generation is unbiased enough for this purpose only because the tiny modulo bias is immaterial to an online verifier with strict attempt limits; the security boundary remains the server-side limit, short lifetime, secret MAC key, and protected repository.

There is an important delivery failure to resolve around `Insert` followed by `SendCode`: the record may exist even if sending fails. Use a transactional outbox so challenge creation and an outbound-send job commit atomically, then let a worker retry delivery idempotently. Never generate a fresh code on an invisible worker retry. A new user-visible resend is a separate policy event and must leave separate evidence.

For autofill, format the message so the operating system can associate the code with the app, and set the React Native text input's platform-appropriate one-time-code autofill hint. Android's SMS Retriever flow uses an app-identifying hash and does not require SMS read permissions [4]. Apple's security guidance documents one-time passcodes as a supported verification-code experience [5]. Autofill only moves characters into a field; the backend still performs every check above.

## Buy or build the boundary, not the controls

The defensible decision is rarely “all managed” or “all self-hosted.” Message delivery depends on telecommunications infrastructure, while policy, evidence, queue routing, and authorization remain application responsibilities regardless of who transports the SMS.

| Boundary | Managed service trade-off | Self-hosted trade-off | Evidence to require |
|---|---|---|---|
| Message transport | Less carrier integration work; external dependency and data processor | More operational ownership; carrier integration still exists | Accepted message ID, timestamps, delivery status, region and retention terms |
| Challenge policy | Faster initial integration; policy may be constrained or opaque | Full control; more security review and on-call load | Policy version, attempt and resend decisions, terminal state |
| Rate limiting | Broad network signals may help; behavior and exportability vary | Portable rules; weaker cross-customer signals | Limit key class, decision, window, override authorization |
| Audit ledger | Convenient exports; retention and schema may couple the system | Controlled schema; integrity and access controls are yours | Immutable event identity, actor, reason, correlation and retention |

This table is a review prompt, not a scorecard. Ask for deletion behavior, regional processing, subprocessor records, export format, delivery-receipt semantics, idempotency support, and failure-mode documentation. Then test those statements. Price belongs in the decision, but on-call load, evidence completeness, lock-in, and the cost of an unsupported recovery path usually dominate the architecture discussion.

## Verify, deploy, and roll back without losing the trail

Test the state machine with a fake clock and concurrent verification calls. Required cases include expiry at the exact boundary, a wrong code followed by the correct code, the final allowed attempt, duplicate request idempotency, two simultaneous correct submissions, delayed outbox delivery, and a resend racing verification. Exactly one concurrent verification may consume the challenge.

In staging, confirm that logs and traces contain the correlation ID but no OTP or complete destination. Exercise app autofill on real Android and iOS devices because simulators do not reproduce the full carrier and operating-system path. Verify accessibility as well: paste and manual entry must still work, and the client must not erase a code merely because a network response is slow.

Deploy policy changes behind a versioned server-side flag, canary by a stable non-sensitive partition, and watch verification completion, limiter rejection, send-to-completion ratio, queue age, and general-queue fallback. Keep the old verifier capable of reading active challenges created under the previous policy until their maximum lifetime has passed.

Rollback should stop new issuance under the new version while preserving verification of already issued challenges and preserving all audit events. Do not truncate the outbox, reclassify account-access forms into the privileged queue, or reset attempt counters. If transport is impaired, the safe degradation is to keep the form in an unverified queue with an explicit pending state and offer a separately reviewed recovery path.

The final acceptance test is plain: given a support ticket, an authorized reviewer can trace it to one consumed challenge and one policy decision, yet cannot recover the OTP from logs or the ledger. Given abusive traffic, the system sheds outbound work before legitimate verification breaches its stated objective. That is the mechanism worth operating.

## References

1. NIST, *Digital Identity Guidelines: Authentication and Authenticator Management*, https://pages.nist.gov/800-63-4/sp800-63b.html
2. OWASP, *Authentication Cheat Sheet*, https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
3. IETF, *HTTP Semantics (RFC 9110), Retry-After*, https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after
4. Google, *SMS Retriever API overview*, https://developers.google.com/identity/sms-retriever/overview
5. Apple, *Securing Logins with iCloud Keychain Verification Codes*, https://support.apple.com/guide/security/securing-logins-with-icloud-keychain-verification-codes-sec7aefe77c3/web
6. Google, *Email sender guidelines*, https://support.google.com/a/answer/81126
7. Twilio, *SMS documentation*, https://www.twilio.com/docs/sms
