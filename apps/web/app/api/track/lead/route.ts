import { parseRequestBody } from "@/lib/api/utils";
import { withSessionEdge } from "@/lib/auth/session-edge";
import { getClickEvent, recordCustomer, recordLead } from "@/lib/tinybird";
import { clickEventSchemaTB, trackLeadRequestSchema } from "@/lib/zod/schemas";
import { nanoid } from "@dub/utils";
import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";

export const runtime = "edge";

// POST /api/track/lead – Track a lead conversion event
export const POST = withSessionEdge(async ({ req, workspace }) => {
  const {
    clickId,
    eventName,
    metadata,
    customerId,
    customerName,
    customerEmail,
    customerAvatar,
  } = trackLeadRequestSchema.parse(await parseRequestBody(req));

  waitUntil(
    (async () => {
      const clickEvent = await getClickEvent({ clickId });

      if (!clickEvent || clickEvent.data.length === 0) {
        return;
      }

      const clickData = clickEventSchemaTB
        .omit({ timestamp: true }) // timestamp is auto generated on insert
        .parse(clickEvent.data[0]);

      const customerInfoPresent =
        Boolean(customerName) ||
        Boolean(customerEmail) ||
        Boolean(customerAvatar);

      await Promise.all([
        recordLead({
          ...clickData,
          event_name: eventName,
          event_id: nanoid(16),
          customer_id: customerId,
          metadata,
        }),

        customerInfoPresent &&
          recordCustomer({
            customer_id: customerId,
            name: customerName,
            email: customerEmail,
            avatar: customerAvatar,
            workspace_id: workspace.id,
          }),
      ]);
    })(),
  );

  return NextResponse.json({ success: true });
});
