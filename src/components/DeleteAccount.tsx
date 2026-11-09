"use client";

import { useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Popup } from "./Popup";
import { deletionErrorMessage } from "./deletionError";
import { clearDeletedAccountStorage } from "./deletionLocal";

export function DeleteAccount() {
  const deleteAccount = useMutation(api.users.deleteAccount);
  const { signOut } = useAuthActions();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return <>
    <button type="button" onClick={() => setOpen(true)} className="label cursor-pointer text-fail">delete account</button>
    {open ? <Popup label="danger zone" title="Delete account?" onClose={() => { if (!busy) setOpen(false); }}>
      <p className="text-sm leading-relaxed text-muted">
        This permanently deletes your account, email, answer history and rating.
        Deletion continues in the background after you leave. There is no undo.
        You must have signed in within the last five minutes. Otherwise, sign out
        and sign in again first.
      </p>
      {error ? <p role="alert" className="mt-4 text-sm text-fail">{error}</p> : null}
      <div className="mt-6 flex gap-4">
        <button type="button" disabled={busy} className="label cursor-pointer border border-fail bg-fail px-5 py-3 text-ink disabled:opacity-50"
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await deleteAccount({});
            } catch (err) {
              setError(deletionErrorMessage(err));
              setBusy(false);
              return;
            }
            try {
              await signOut();
            } catch {
              // The server may already have removed this session.
            }
            try {
              clearDeletedAccountStorage(window.localStorage);
            } catch {
              setError("Deletion has started. This browser could not clear local data. Clear this site's data in browser settings before sharing this device.");
              return;
            }
            // Discard in-memory progress, pending requests and query caches.
            window.location.replace("/signin");
          }}>
          {busy ? "deleting…" : "yes, permanently delete account"}
        </button>
        <button type="button" autoFocus disabled={busy} onClick={() => setOpen(false)} className="label cursor-pointer text-muted">cancel</button>
      </div>
    </Popup> : null}
  </>;
}
