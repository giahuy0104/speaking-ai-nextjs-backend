import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AdminChildSpeechTest } from "@/components/AdminChildSpeechTest";
import { hasValidAdminSession } from "@/lib/adminAuth";

export const metadata: Metadata = {
  title: "Kiểm tra giọng trẻ em | AI Speaking",
  description:
    "Kiểm tra riêng Cloudflare ASR và lớp sửa giọng trẻ em, không chạy dịch hoặc TTS.",
};

export default async function AdminChildSpeechTestPage() {
  if (!(await hasValidAdminSession())) {
    redirect("/admin/login");
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <AdminChildSpeechTest />
    </main>
  );
}
