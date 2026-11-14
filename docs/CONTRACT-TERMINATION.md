# Contract termination workflow

The workflow records termination requests without rewriting the approved or signed contract PDF.
It is available for approved, awaiting-signature, and signed contracts.

## Roles and lifecycle

- A user who can edit the contract in its team scope can request termination or withdraw their own pending request.
- A user with scoped `contracts.approve` can accept or reject a request. An Owner may decide their own request; other approvers may not.
- Acceptance records organizational approval. The scheduler executes the termination on its effective date, closes any open signing round, revokes its links, and sets the contract status to `terminated`.
- Requests still awaiting a response expire after 30 days. Status changes are audited; termination events are append-only.
- A supplemental bilingual PDF notice is available after execution. It does not replace or alter stored approved/signed documents.

## API

- `GET /contracts/:id/termination`
- `POST /contracts/:id/termination`
- `POST /contracts/:id/termination/respond`
- `POST /contracts/:id/termination/withdraw`
- `POST /contracts/:id/termination/execute`
- `GET /contracts/:id/termination/notice.pdf`

The request requires an effective date that satisfies the selected notice period. Breach and
non-performance reasons require written details. The database migration is generated from the
Drizzle schema; no new environment variables are required.

## Counterparty boundary

Contract recipients are external contacts, not organization users. The current workflow therefore
uses an internal scoped approver as the responding party and emails the external recipient after
execution; it does not collect the recipient's acceptance. Confirm the organization's legal
process and any required external acceptance with qualified counsel before relying on this
workflow.

## Manual verification

1. Approve a contract as a scoped approver, then request termination as its editor.
2. Confirm another authorized approver can accept or reject it and that the initiator cannot
   approve their own request unless they are an Owner.
3. Use an effective date of today and run a scheduler tick. Confirm the contract becomes
   terminated and any in-progress signing link stops working.
4. Compare the approved/signed PDF hash before and after execution; download the supplemental
   notice and confirm its content.
5. Age an unanswered request beyond 30 days and run a scheduler tick; confirm it expires and the
   requestor receives an in-app notification.
