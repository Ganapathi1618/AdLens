"use client";
import { Bell } from "lucide-react";
import PageHeader from "@/components/PageHeader";

// Threshold alerts are raised by the rules engine from synced or uploaded
// metrics. Until a rule fires against real data there is nothing to show, and
// nothing to invent: an empty alerts page is the honest state, not a bug.
export default function Alerts() {
  return (
    <div className="max-w-5xl mx-auto px-8 py-7">
      <PageHeader kicker="Monitoring" title="Alerts" sub="Threshold rules over synced and uploaded metrics" />
      <div className="card p-8 text-center">
        <Bell size={28} className="mx-auto text-mut mb-3" />
        <div className="font-bold text-[15px] mb-1">No threshold alerts have fired</div>
        <p className="text-[13px] text-mut max-w-md mx-auto">
          Alerts are raised from your metrics against rule thresholds. Connect an ad
          account or upload a report, and anything that breaches a threshold appears here.
        </p>
      </div>
    </div>
  );
}
