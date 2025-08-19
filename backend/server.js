import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import cors from "cors";
import { createClient } from '@supabase/supabase-js'; // Import Supabase client

dotenv.config(); // Loads environment variables from .env file for local development
const app = express();

// Initialize Supabase Client with the Service Role Key for backend operations
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yzwfldypkwqndxjchgit.supabase.co'; // Your Supabase Project URL
// IMPORTANT: Use SUPABASE_SERVICE_ROLE_KEY for your backend for full access, bypassing RLS.
// This key must NEVER be exposed on the frontend.
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl6d2ZsZHlwa3dxbmR4amNoZ2l0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0OTMyMDQ5NSwiZXhwIjoyMDY0ODk2NDk1fQ.HiR8wH-_eYVinBce6B8xPB5_GW8DI0iJDvQXRFvu1nY'; // Replace with your actual Supabase Service Role Key from Supabase Dashboard -> Project Settings -> API

const supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);


// Initialize Stripe with your Secret Key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
// Get the Webhook Secret from environment variables. Crucial for verifying Stripe events.
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Enable CORS for all routes (consider restricting this in production to specific origins)
app.use(cors());

// Stripe webhook endpoint MUST come before express.json()
// because Stripe sends raw body and express.json() parses it, which would break signature verification.
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Verify the webhook signature to ensure the event is genuinely from Stripe
    // Uses the raw request body, signature, and your webhook secret
    event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
  } catch (err) {
    console.error(`Webhook Signature Verification Error: ${err.message}`);
    // Respond with 400 if signature verification fails
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Log the received Stripe event for debugging and record-keeping
  console.log(`Received Stripe event: ${event.type} (ID: ${event.id})`);

  try {
    // Insert the raw webhook event into your webhook_logs table in Supabase
    // This helps in debugging and replaying events if needed
    const { error: logError } = await supabaseClient
      .from('webhook_logs')
      .insert({
        event_id: event.id,
        event_type: event.type,
        payload: event.data.object, // Store the entire event data object for comprehensive logging
        received_at: new Date().toISOString(),
        processed: false // Mark as false initially, set to true after successful processing
      });

    if (logError) {
      console.error("Error inserting webhook log:", logError);
      // Even if logging fails, attempt to process the main event to avoid data inconsistency
      // The event will be re-attempted by Stripe if a 200 response isn't sent
    }

    // Handle different Stripe event types using a switch statement
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        console.log('Stripe Checkout Session Completed:', session.id);

        // Extract relevant data from the session object
        const rentHistoryId = session.client_reference_id; // Your custom reference ID
        const paidAmountStripe = session.amount_total / 100; // Convert cents (Stripe's unit) to your currency (e.g., AED)
        const stripePaymentId = session.payment_intent; // The ID of the Payment Intent
        const customerEmail = session.customer_details ? session.customer_details.email : null;
        const currency = session.currency ? session.currency.toUpperCase() : 'AED'; // Default to AED as per your schema
        const receiptUrl = session.receipt_url || `https://dashboard.stripe.com/test/payments/${stripePaymentId}`; // Fallback receipt URL for testing

        // Validate essential data
        if (!rentHistoryId) {
            console.error('Error: rentHistoryId not found in checkout.session.completed event.');
            // Update webhook log with error message
            await supabaseClient.from('webhook_logs').update({ error_message: 'Missing rentHistoryId' }).eq('event_id', event.id);
            return res.status(400).send('Missing rentHistoryId'); // Respond with 400 if critical data is missing
        }

        // Use a try-catch block for database operations to ensure robust error handling
        try {
            // 1. Fetch the current rental record from 'rent_history'
            const { data: currentRentalRecord, error: fetchRentalError } = await supabaseClient
                .from('rent_history')
                .select('*')
                .eq('id', rentHistoryId)
                .single(); // Use single() to expect one record

            if (fetchRentalError) {
                console.error('Error fetching rental record for webhook:', fetchRentalError);
                throw new Error(`Failed to fetch rental record: ${fetchRentalError.message}`);
            }

            // Calculate new paid amount and balance
            const newPaidAmount = parseFloat(currentRentalRecord.paid_amount || 0) + paidAmountStripe;
            const newBalance = parseFloat(currentRentalRecord.total_price || 0) - newPaidAmount;
            // Determine new payment status based on balance
            const newPaymentStatus = newBalance <= 0 ? 'Paid' : 'Partially Paid';

            // 2. Update the 'rent_history' table with new payment details
            const { error: updateRentError } = await supabaseClient
                .from('rent_history')
                .update({
                    paid_amount: newPaidAmount,
                    balance: newBalance,
                    payment_status: newPaymentStatus,
                    updated_at: new Date().toISOString() // Record when the update occurred
                })
                .eq('id', rentHistoryId);

            if (updateRentError) {
                console.error('Error updating rent_history in webhook:', updateRentError);
                throw new Error(`Failed to update rent_history: ${updateRentError.message}`);
            }

            // 3. Insert a new record into the 'payments' table
            const { error: insertPaymentError } = await supabaseClient
                .from('payments')
                .insert({
                    rent_history_id: rentHistoryId,
                    amount: paidAmountStripe,
                    payment_date: new Date().toISOString().split('T')[0], // YYYY-MM-DD format
                    payment_method: 'Stripe Card Payment',
                    notes: `Stripe Payment for session ${session.id}`,
                    stripe_payment_id: stripePaymentId,
                    customer_name: session.customer_details ? session.customer_details.name : null,
                    currency: currency,
                    status: 'succeeded', // Assuming success for checkout.session.completed
                    email: customerEmail,
                    webhook_event_id: event.id, // Link to the raw webhook log
                    receipt_url: receiptUrl
                });

            if (insertPaymentError) {
                console.error('Error inserting payment in webhook:', insertPaymentError);
                throw new Error(`Failed to insert payment record: ${insertPaymentError.message}`);
            }

            // Mark the webhook log as successfully processed
            await supabaseClient.from('webhook_logs').update({ processed: true, error_message: null }).eq('event_id', event.id);
            console.log(`Payment and Rent History updated successfully for rentHistoryId: ${rentHistoryId}`);

        } catch (dbError) {
            // Catch any errors during database operations, log them, and update webhook_logs
            console.error('Database update failed for checkout.session.completed event:', dbError);
            await supabaseClient.from('webhook_logs').update({ processed: false, error_message: dbError.message }).eq('event_id', event.id);
            // Respond with 500 so Stripe knows to retry the webhook
            return res.status(500).send('Database update failed');
        }

        break;

      case 'payment_intent.payment_failed':
        const paymentIntentFailed = event.data.object;
        console.log('Stripe Payment Intent Failed:', paymentIntentFailed.id);
        // Implement logic for failed payments (e.g., send notification, update payment record status)
        await supabaseClient.from('webhook_logs').update({ processed: true, error_message: 'Payment failed' }).eq('event_id', event.id);
        break;

      // Add more cases here to handle other event types if needed (e.g., 'customer.created', 'invoice.paid')
      default:
        // Log unhandled event types but still acknowledge them
        console.log(`Unhandled Stripe event type: ${event.type}`);
        await supabaseClient.from('webhook_logs').update({ processed: true, notes: 'Unhandled event type' }).eq('event_id', event.id);
    }

    // Send a 200 response to Stripe to acknowledge successful receipt and processing of the event
    // This prevents Stripe from retrying the webhook.
    res.json({received: true});

  } catch (error) {
    // Catch any unexpected errors during webhook processing
    console.error("General Error processing webhook:", error);
    // Mark the webhook log as failed and store the error message
    await supabaseClient.from('webhook_logs').update({ processed: false, error_message: error.message }).eq('event_id', event.id);
    // Send a 500 response to indicate a server error to Stripe, prompting a retry
    res.status(500).send('Internal Server Error');
  }
});


// Middleware to parse JSON bodies for non-webhook routes (like /create-checkout-session)
app.use(express.json());

// Basic health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is running and healthy" });
});

// Endpoint to create a Stripe Checkout session
app.post("/create-checkout-session", async (req, res) => {
  // Extract necessary data from the request body
  const { amount, rentHistoryId, customerEmail, successUrl, cancelUrl } = req.body;

  // Basic validation for required fields
  if (!amount || !rentHistoryId) {
    return res.status(400).json({ error: "Amount and rentHistoryId are required." });
  }

  try {
    // Create a new Stripe Checkout session
    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "aed", // Currency is AED as per your schema and requirements
            product_data: {
              name: "Car Rental Payment", // Product name displayed on Stripe Checkout page
              description: `Payment for agreement ${rentHistoryId}` // Description for the payment
            },
            unit_amount: Math.round(amount * 100), // Amount in cents (Stripe's smallest currency unit)
          },
          quantity: 1, // Always 1 for a single payment
        },
      ],
      mode: "payment", // Set mode to 'payment' for one-time payments
      // Dynamic success and cancel URLs to redirect user after payment
      success_url: successUrl || `${req.protocol}://${req.get('host')}/success.html?session_id={CHECKOUT_SESSION_ID}&rentHistoryId=${rentHistoryId}`,
      cancel_url: cancelUrl || `${req.protocol}://${req.get('host')}/cancel.html?rentHistoryId=${rentHistoryId}`,
      client_reference_id: rentHistoryId, // Attach your internal rentHistoryId to the Stripe session
                                         // This is crucial for matching the webhook event back to your record
      customer_email: customerEmail, // Pre-fill the customer's email in Stripe Checkout
      // payment_method_types: ['card'], // Uncomment if you want to explicitly specify payment methods
    });
    // Respond with the Stripe Checkout session URL and ID
    res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error("Stripe Error creating checkout session:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Define the port for the backend server
const PORT = process.env.PORT || 4242; // Use environment variable PORT if available, otherwise default to 4242

// Start the Express server
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));

