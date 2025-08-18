import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import cors from "cors";
import { createClient } from '@supabase/supabase-js'; // Import Supabase client

dotenv.config();
const app = express();

// Initialize Supabase Client
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yzwfldypkwqndxjchgit.supabase.co'; // Replace with your Supabase URL
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl6d2ZsZHlwa3dxbmR4amNoZ2l0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDkzMjA0OTUsImV4cCI6MjA2NDg5NjQ5NX0.i3HOii7L9mJ-cBZ2us3TRmS0-GI9bylHuLe9INAu4zY'; // Replace with your Supabase Key
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);


const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET; // Ensure this is set in your .env for production

app.use(cors()); // Enable CORS for all routes (consider restricting in production)

// Stripe webhook endpoint MUST come before express.json()
// because Stripe sends raw body and express.json() parses it.
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Verify the webhook signature to ensure the event is from Stripe
    event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
  } catch (err) {
    console.error(`Webhook Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Log the webhook event
  console.log(`Received Stripe event: ${event.type}`);

  try {
    // Insert into webhook_logs table first
    const { error: logError } = await supabaseClient
      .from('webhook_logs')
      .insert({
        event_id: event.id,
        event_type: event.type,
        payload: event.data.object, // Store the entire event data object
        received_at: new Date().toISOString(),
        processed: false // Mark as false initially
      });

    if (logError) {
      console.error("Error inserting webhook log:", logError);
      // Even if logging fails, try to process the main event to avoid data inconsistency
    }

    // Handle the event
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        console.log('Checkout Session Completed:', session.id);

        const rentHistoryId = session.client_reference_id;
        const paidAmountStripe = session.amount_total / 100; // Convert cents to dollars/AED
        const stripePaymentId = session.payment_intent;
        const customerEmail = session.customer_details ? session.customer_details.email : null;
        const currency = session.currency ? session.currency.toUpperCase() : 'USD';
        const receiptUrl = session.receipt_url || `https://dashboard.stripe.com/test/payments/${stripePaymentId}`; // Fallback for receipt URL

        if (!rentHistoryId) {
            console.error('Error: rentHistoryId not found in checkout.session.completed event.');
            await supabaseClient.from('webhook_logs').update({ error_message: 'Missing rentHistoryId' }).eq('event_id', event.id);
            return res.status(400).send('Missing rentHistoryId');
        }

        // Start a transaction-like process for updating multiple tables
        // Supabase doesn't have explicit transactions like SQL, so we handle sequentially
        // with careful error handling and rollback logic (or marking as failed).
        try {
            // 1. Fetch current rental record to update paid_amount and balance
            const { data: currentRentalRecord, error: fetchRentalError } = await supabaseClient
                .from('rent_history')
                .select('*')
                .eq('id', rentHistoryId)
                .single();

            if (fetchRentalError) {
                console.error('Error fetching rental record for webhook:', fetchRentalError);
                throw new Error(`Failed to fetch rental record: ${fetchRentalError.message}`);
            }

            const newPaidAmount = parseFloat(currentRentalRecord.paid_amount || 0) + paidAmountStripe;
            const newBalance = parseFloat(currentRentalRecord.total_price || 0) - newPaidAmount;
            const newPaymentStatus = newBalance <= 0 ? 'Paid' : 'Partially Paid';

            // 2. Update rent_history
            const { error: updateRentError } = await supabaseClient
                .from('rent_history')
                .update({
                    paid_amount: newPaidAmount,
                    balance: newBalance,
                    payment_status: newPaymentStatus,
                    updated_at: new Date().toISOString()
                })
                .eq('id', rentHistoryId);

            if (updateRentError) {
                console.error('Error updating rent_history in webhook:', updateRentError);
                throw new Error(`Failed to update rent_history: ${updateRentError.message}`);
            }

            // 3. Insert payment record
            const { error: insertPaymentError } = await supabaseClient
                .from('payments')
                .insert({
                    rent_history_id: rentHistoryId,
                    amount: paidAmountStripe,
                    payment_date: new Date().toISOString().split('T')[0], // YYYY-MM-DD
                    payment_method: 'Stripe Card Payment',
                    notes: `Stripe Payment for session ${session.id}`,
                    stripe_payment_id: stripePaymentId,
                    customer_name: session.customer_details ? session.customer_details.name : null,
                    currency: currency,
                    status: 'succeeded',
                    email: customerEmail,
                    webhook_event_id: event.id,
                    receipt_url: receiptUrl
                });

            if (insertPaymentError) {
                console.error('Error inserting payment in webhook:', insertPaymentError);
                throw new Error(`Failed to insert payment record: ${insertPaymentError.message}`);
            }

            // Mark webhook log as processed
            await supabaseClient.from('webhook_logs').update({ processed: true }).eq('event_id', event.id);
            console.log(`Payment and Rent History updated successfully for ${rentHistoryId}`);

        } catch (dbError) {
            console.error('Database update failed for checkout.session.completed:', dbError);
            await supabaseClient.from('webhook_logs').update({ error_message: dbError.message }).eq('event_id', event.id);
            return res.status(500).send('Database update failed');
        }

        break;
      case 'payment_intent.payment_failed':
        const paymentIntentFailed = event.data.object;
        console.log('Payment Intent Failed:', paymentIntentFailed.id);
        // You might want to update a payment record to 'failed' here
        // or log this specifically for review.
        await supabaseClient.from('webhook_logs').update({ processed: true, error_message: 'Payment failed' }).eq('event_id', event.id);
        break;
      // ... handle other event types
      default:
        console.log(`Unhandled event type ${event.type}`);
        await supabaseClient.from('webhook_logs').update({ processed: true, notes: 'Unhandled event type' }).eq('event_id', event.id);
    }

    // Return a 200 response to acknowledge receipt of the event
    res.json({received: true});

  } catch (error) {
    console.error("Error processing webhook:", error);
    // If an unhandled error occurs during processing, mark the log accordingly
    await supabaseClient.from('webhook_logs').update({ processed: false, error_message: error.message }).eq('event_id', event.id);
    res.status(500).send('Internal Server Error');
  }
});


// Middleware to parse JSON bodies for non-webhook routes
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/create-checkout-session", async (req, res) => {
  const { amount, rentHistoryId, customerEmail, successUrl, cancelUrl } = req.body;

  if (!amount || !rentHistoryId) {
    return res.status(400).json({ error: "Amount and rentHistoryId are required." });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "aed", // Using AED as per your schema, Stripe supports this
            product_data: {
              name: "Car Rental Payment",
              description: `Payment for agreement ${rentHistoryId}`
            },
            unit_amount: Math.round(amount * 100), // Convert AED to cents
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: successUrl || `${req.protocol}://${req.get('host')}/success.html?session_id={CHECKOUT_SESSION_ID}&rentHistoryId=${rentHistoryId}`,
      cancel_url: cancelUrl || `${req.protocol}://${req.get('host')}/cancel.html?rentHistoryId=${rentHistoryId}`,
      client_reference_id: rentHistoryId, // Important for webhooks to link back to your rental record
      customer_email: customerEmail, // Pre-fill customer email in Stripe Checkout
      // payment_method_types: ['card'], // Specify payment methods if needed
    });
    res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error("Stripe Error creating checkout session:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));

