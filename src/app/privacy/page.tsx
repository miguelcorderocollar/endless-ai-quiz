import Link from "next/link";

export const metadata = { title: "Privacy notice | Endless AI" };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-xl px-6 py-14 text-sm leading-relaxed text-paper">
      <p className="label text-muted">Endless AI · updated 9 November 2026</p>
      <h1 className="mt-3 font-display text-3xl">Privacy notice</h1>
      <p className="mt-4">The data controller is Miguel Cordero Collar, the project owner. For privacy questions or deletion help, contact the owner through <a className="underline" href="https://github.com/miguelcorderocollar/endless-ai-quiz/issues">GitHub issues</a>. Do not post your password or private account details publicly.</p>
      <h2 className="mt-8 font-display text-xl">What we store</h2>
      <p className="mt-3">When you create an account, we store your email, a password hash, an account handle and any display name you choose. We store your answers, question identifiers, correctness, rating changes and timestamps to show your progress across devices. Authentication also stores sessions, refresh tokens and sign-in rate limits.</p>
      <p className="mt-3">Sign-in requires an account. Guests can play without signing in, and their progress stays on the device. The browser and mobile app also store question caches, recent answers, pending answer uploads, profile details and install preferences so the app can work offline. Signing in can associate local progress with your account.</p>
      <h2 className="mt-8 font-display text-xl">Where and why</h2>
      <p className="mt-3">Convex hosts the database and authentication. Vercel hosts the website. Requests to these services include technical information such as your IP address and browser details, which the providers may process in operational logs. We use account data to authenticate you, sync progress and calculate quiz statistics.</p>
      <h2 className="mt-8 font-display text-xl">Retention and deletion</h2>
      <p className="mt-3">Account data stays until you delete your account. On the website, in Profile, open the danger zone and choose Delete account. You must have signed in within the last five minutes. Confirming starts permanent deletion of your profile, email, answers, statistics and authentication records in background batches. New progress writes are blocked immediately. Reset progress alone keeps your account.</p>
      <p className="mt-3">The mobile app can create accounts but does not yet offer in-app account deletion. Use the website with the same account to delete it, or contact the project owner through GitHub issues for help. In-app deletion will be added in a follow-up.</p>
      <p className="mt-3">Deletion clears this browser&apos;s local progress, pending answers, profile and question caches. Other browsers and the mobile app may retain offline copies. Clear their site data or the mobile app data separately. Provider backups and operational logs may remain under Convex and Vercel retention policies; this app&apos;s deletion process does not erase those copies directly.</p>
      <h2 className="mt-8 font-display text-xl">Passwords and questions</h2>
      <p className="mt-3">Password recovery and email verification are not available yet. If you forget your password, you cannot recover the account or use self-service deletion. Do not rely on email verification to prove ownership of another person&apos;s email address.</p>
      <Link href="/signin" className="label mt-10 inline-block text-signal">back to sign in</Link>
    </main>
  );
}
