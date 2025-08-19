import Stripe from "stripe";
import { buffer } from "micro"; // Used to get raw body for webhook verification
import { createClient } from "@supabase/supabase-js";

// Initialize Stripe with your Secret Key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Initialize Supabase Client with the Service Role Key for backend operations
// This key provides full administrative access and bypasses Row Level Security (RLS).
// It must be securely stored as an environment variable and NEVER exposed on the frontend.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // Use the Service Role Key here!
);

// Configuration for Vercel Serverless Functions to handle raw body
export const config = {
  api: {
    bodyParser: false, // Essential for Stripe webhook signature verification
  },
};

// Main webhook handler function
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sig = req.headers["stripe-signature"];
  const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET; // Get secret from env

  let event;
  let buf;

  try {
    // Read the raw request body buffer for signature verification
    buf = await buffer(req);
    // Verify the webhook signature to ensure the event is genuinely from Stripe
    event = stripe.webhooks.constructEvent(buf, sig, stripeWebhookSecret);
  } catch (err) {
    console.error("❌ Webhook signature verification error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Log the received Stripe event for debugging and record-keeping
  console.log(`Received Stripe event: ${event.type} (ID: ${event.id})`);

  try {
    // --- Step 1: Log the raw webhook event (for debugging and audit) ---
    const { error: logInsertError } = await supabase
      .from("webhook_logs")
      .insert({
        event_id: event.id,
        event_type: event.type,
        payload: event.data.object, // Store the entire event data object
        received_at: new Date().toISOString(),
        processed: false, // Mark as false initially
      });

    if (logInsertError) {
      console.error("Error inserting initial webhook log:", logInsertError);
      // Don't stop here, try to process the main event anyway
    }

    // --- Step 2: Handle different Stripe event types ---
    switch (event.type) {
      case "checkout.session.completed":
        const session = event.data.object;
        console.log("✅ Checkout Session Completed:", session.id, session.customer_details?.email);

        const rentHistoryId = session.client_reference_id;
        const paidAmountStripe = session.amount_total / 100; // Convert cents to your currency (e.g., AED)
        const stripePaymentId = session.payment_intent;
        const customerEmail = session.customer_details ? session.customer_details.email : null;
        const currency = session.currency ? session.currency.toUpperCase() : 'AED'; // Default to AED if not present
        const receiptUrl = session.receipt_url || `https://dashboard.stripe.com/test/payments/${stripePaymentId}`; // Fallback

        if (!rentHistoryId) {
          console.error("Error: rentHistoryId not found in checkout.session.completed event. Session ID:", session.id);
          await supabase.from("webhook_logs").update({ error_message: "Missing rentHistoryId" }).eq("event_id", event.id);
          return res.status(400).send("Missing rentHistoryId"); // Respond 400 for bad request data
        }

        try {
          // 1. Fetch the current rental record from 'rent_history'
          const { data: currentRentalRecord, error: fetchRentalError } = await supabase
            .from("rent_history")
            .select("total_price, paid_amount, balance") // Select only necessary fields
            .eq("id", rentHistoryId)
            .single();

          if (fetchRentalError) {
            console.error("Error fetching rental record:", fetchRentalError);
            throw new Error(`Failed to fetch rental record: ${fetchRentalError.message}`);
          }

          const newPaidAmount = parseFloat(currentRentalRecord.paid_amount || 0) + paidAmountStripe;
          const newBalance = parseFloat(currentRentalRecord.total_price || 0) - newPaidAmount;
          const newPaymentStatus = newBalance <= 0 ? "Paid" : "Partially Paid";

          // 2. Update the 'rent_history' table
          const { error: updateRentError } = await supabase
            .from("rent_history")
            .update({
              paid_amount: newPaidAmount,
              balance: newBalance,
              payment_status: newPaymentStatus,
              updated_at: new Date().toISOString(),
            })
            .eq("id", rentHistoryId);

          if (updateRentError) {
            console.error("Error updating rent_history:", updateRentError);
            throw new Error(`Failed to update rent_history: ${updateRentError.message}`);
          }

          // 3. Insert a new record into the 'payments' table
          const { error: insertPaymentError } = await supabase
            .from("payments")
            .insert({
              rent_history_id: rentHistoryId,
              amount: paidAmountStripe,
              payment_date: new Date().toISOString().split("T")[0],
              payment_method: session.payment_method_types[0] || 'card', // Use actual method, fallback to 'card'
              notes: `Stripe Payment for session ${session.id}`,
              stripe_payment_id: stripePaymentId,
              customer_name: session.customer_details ? session.customer_details.name : null,
              currency: currency,
              status: "succeeded",
              email: customerEmail,
              webhook_event_id: event.id,
              receipt_url: receiptUrl,
            });

          if (insertPaymentError) {
            console.error("Error inserting payment:", insertPaymentError);
            throw new Error(`Failed to insert payment record: ${insertPaymentError.message}`);
          }

          // Mark the webhook log as successfully processed
          await supabase.from("webhook_logs").update({ processed: true, error_message: null }).eq("event_id", event.id);
          console.log(`Payment and Rent History updated successfully for rentHistoryId: ${rentHistoryId}`);

        } catch (dbError) {
          // Catch any errors during database operations, log them, and update webhook_logs
          console.error("Database operation failed for checkout.session.completed event:", dbError);
          await supabase.from("webhook_logs").update({ processed: false, error_message: dbError.message }).eq("event_id", event.id);
          // Respond with 500 so Stripe knows to retry the webhook
          return res.status(500).send(`Database update failed: ${dbError.message}`);
        }
        break;

      case "payment_intent.payment_failed":
        const paymentIntentFailed = event.data.object;
        console.log("❌ Payment Intent Failed:", paymentIntentFailed.id);
        // You might want to update a payment record to 'failed' here
        // or log this specifically for review.
        await supabase.from("webhook_logs").update({ processed: true, error_message: "Payment failed" }).eq("event_id", event.id);
        break;

      // Add more cases here to handle other event types if needed (e.g., 'customer.created', 'invoice.paid')
      default:
        // Log unhandled event types but still acknowledge them
        console.log(`Unhandled Stripe event type: ${event.type}`);
        await supabase.from("webhook_logs").update({ processed: true, notes: `Unhandled event type: ${event.type}` }).eq("event_id", event.id);
    }

    // --- Step 3: Send a 200 response to Stripe ---
    // This acknowledges successful receipt and processing of the event
    // This prevents Stripe from retrying the webhook.
    res.json({ received: true });

  } catch (error) {
    // Catch any unexpected errors during webhook processing
    console.error("General Error processing webhook:", error);
    // Mark the webhook log as failed and store the error message
    await supabase.from("webhook_logs").update({ processed: false, error_message: error.message }).eq("event_id", event.id);
    // Send a 500 response to indicate a server error to Stripe, prompting a retry
    res.status(500).send(`Internal Server Error: ${error.message}`);
  }
}
