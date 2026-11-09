"use client";

import { useRouter } from "next/navigation";

import { SignInForm } from "@/components/Account";
import { Shell } from "@/components/QuizFromConvex";
import { useLocalSignOut } from "@/lib/useLocalSignOut";

export default function SignInPage() {
  const router = useRouter();
  const { leave, error } = useLocalSignOut();

  return (
    <Shell showElo={false}>
      <main className="flex flex-1 flex-col pt-14">
        <p className="label text-muted">account</p>
        <h1 className="mt-3 font-display text-3xl">Sign in to Endless AI</h1>
        <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted">
          One account keeps your Elo, streak and done list on every device. Guests keep
          playing locally — nothing is lost by waiting.
        </p>
        <div className="mt-8">
          <SignInForm
            layout="page"
            onDone={() => router.push("/")}
            onSignOut={() => void leave()}
          />
          {error ? <p role="alert">{error}</p> : null}
        </div>
      </main>
    </Shell>
  );
}
