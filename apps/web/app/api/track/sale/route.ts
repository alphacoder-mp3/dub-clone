import { DubApiError } from "@/lib/api/errors";
import { createSaleData } from "@/lib/api/sales/sale";
import { parseRequestBody } from "@/lib/api/utils";
import { withWorkspaceEdge } from "@/lib/auth/workspace-edge";
import { prismaEdge } from "@/lib/prisma/edge";
import { getLeadEvent, recordSale } from "@/lib/tinybird";
import { sendWorkspaceWebhookOnEdge } from "@/lib/webhook/publish-edge";
import { transformSaleEventData } from "@/lib/webhook/transform";
import { clickEventSchemaTB } from "@/lib/zod/schemas/clicks";
import {
  trackSaleRequestSchema,
  trackSaleResponseSchema,
} from "@/lib/zod/schemas/sales";
import { nanoid } from "@dub/utils";
import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";

export const runtime = "edge";

// POST /api/track/sale – Track a sale conversion event
export const POST = withWorkspaceEdge(
  async ({ req, workspace }) => {
    const {
      externalId,
      customerId, // deprecated
      paymentProcessor,
      invoiceId,
      amount,
      currency,
      metadata,
      eventName,
    } = trackSaleRequestSchema.parse(await parseRequestBody(req));

    const customerExternalId = customerId || externalId;

    if (!customerExternalId) {
      throw new DubApiError({
        code: "bad_request",
        message: "externalId is required",
      });
    }

    // Find customer
    const customer = await prismaEdge.customer.findUnique({
      where: {
        projectId_externalId: {
          projectId: workspace.id,
          externalId: customerExternalId,
        },
      },
    });

    if (!customer) {
      throw new DubApiError({
        code: "not_found",
        message: `Customer not found for externalId: ${customerExternalId}`,
      });
    }

    // Find lead
    const leadEvent = await getLeadEvent({ customerId: customer.id });

    if (!leadEvent || leadEvent.data.length === 0) {
      throw new DubApiError({
        code: "not_found",
        message: `Lead event not found for externalId: ${customerExternalId}`,
      });
    }

    const clickData = clickEventSchemaTB
      .omit({ timestamp: true })
      .parse(leadEvent.data[0]);

    const programEnrollment = await prismaEdge.programEnrollment.findUnique({
      where: {
        linkId: clickData.link_id,
      },
      include: {
        program: true,
      },
    });

    waitUntil(
      (async () => {
        const eventId = nanoid(16);

        const [_sale, link, _project] = await Promise.all([
          recordSale({
            ...clickData,
            event_id: eventId,
            event_name: eventName,
            customer_id: customer.id,
            payment_processor: paymentProcessor,
            amount,
            currency,
            invoice_id: invoiceId || "",
            metadata: metadata ? JSON.stringify(metadata) : "",
          }),

          // update link sales count
          prismaEdge.link.update({
            where: {
              id: clickData.link_id,
            },
            data: {
              sales: {
                increment: 1,
              },
              saleAmount: {
                increment: amount,
              },
            },
          }),
          // update workspace sales usage
          prismaEdge.project.update({
            where: {
              id: workspace.id,
            },
            data: {
              usage: {
                increment: 1,
              },
              salesUsage: {
                increment: amount,
              },
            },
          }),

          ...(programEnrollment
            ? [
                prismaEdge.sale.create({
                  data: createSaleData({
                    customerId: customer.id,
                    linkId: clickData.link_id,
                    clickId: clickData.click_id,
                    invoiceId,
                    eventId,
                    paymentProcessor,
                    amount,
                    currency,
                    partnerId: programEnrollment.partnerId,
                    program: programEnrollment.program,
                    metadata: clickData,
                  }),
                }),
              ]
            : []),
        ]);

        const sale = transformSaleEventData({
          ...clickData,
          link,
          eventName,
          paymentProcessor,
          invoiceId,
          amount,
          currency,
          customerId: customer.id,
          customerExternalId: customer.externalId,
          customerName: customer.name,
          customerEmail: customer.email,
          customerAvatar: customer.avatar,
          customerCreatedAt: customer.createdAt,
        });

        await sendWorkspaceWebhookOnEdge({
          trigger: "sale.created",
          data: sale,
          workspace,
        });
      })(),
    );

    const sale = trackSaleResponseSchema.parse({
      eventName,
      customer,
      sale: {
        amount,
        currency,
        invoiceId,
        paymentProcessor,
        metadata,
      },
    });

    return NextResponse.json({
      ...sale,
      // for backwards compatibility – will remove soon
      amount,
      currency,
      invoiceId,
      paymentProcessor,
      metadata,
    });
  },
  {
    requiredAddOn: "conversion",
    requiredPermissions: ["conversions.write"],
  },
);
