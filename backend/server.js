import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import { createClient } from "@supabase/supabase-js";

dotenv.config();
const app = express();
const port = process.env.PORT || 4242;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(bodyParser.json());

// Create Checkout Session
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Car Rental Payment" },
            unit_amount: 1000, // $10 test payment
          },
          quantity: 1,
        },
      ],
      success_url: `${req.headers.origin}/frontend/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin}/frontend/cancel.html`,
      metadata: {
        rent_history_id: "11111111-1111-1111-1111-111111111111", // demo UUID
        customer_name: "Test User",
        notes: "Demo Payment",
      },
    });
    res.json({ id: session.id, url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Webhook
app.post("/api/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const payment = {
      rent_history_id: session.metadata.rent_history_id,
      amount: session.amount_total / 100,
      payment_date: new Date().toISOString().split("T")[0],
      payment_method: "card",
      notes: session.metadata.notes,
      stripe_payment_id: session.payment_intent,
      customer_name: session.metadata.customer_name,
      currency: session.currency,
      status: session.payment_status,
      email: session.customer_details?.email || null,
      webhook_event_id: event.id,
      receipt_url: session.receipt_url || null,
    };
    await supabase.from("payments").insert(payment);
  }

  res.json({ received: true });
});

// Confirm fallback (from success.html)
app.post("/api/confirm", async (req, res) => {
  const { session_id } = req.body;
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    const payment = {
      rent_history_id: session.metadata.rent_history_id,
      amount: session.amount_total / 100,
      payment_date: new Date().toISOString().split("T")[0],
      payment_method: "card",
      notes: session.metadata.notes,
      stripe_payment_id: session.payment_intent,
      customer_name: session.metadata.customer_name,
      currency: session.currency,
      status: session.payment_status,
      email: session.customer_details?.email || null,
      webhook_event_id: session.id,
      receipt_url: session.receipt_url || null,
    };
    await supabase.from("payments").insert(payment);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => console.log(`Server running on ${port}`));
