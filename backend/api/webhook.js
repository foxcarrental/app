import Stripe from "stripe";
import { buffer } from "micro";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    console.log("✅ Payment completed:", session.id, session.customer_email);

    const { error } = await supabase.from("payments").insert([
      {
        rent_history_id: "00000000-0000-0000-0000-000000000000",
        amount: session.amount_total / 100,
        payment_date: new Date().toISOString().split("T")[0],
        payment_method: session.payment_method_types[0],
        stripe_payment_id: session.id,
        customer_name: session.customer_email,
        currency: session.currency,
        status: session.payment_status,
        email: session.customer_email
      },
    ]);

    if (error) console.error("Supabase insert error:", error.message);
  }

  res.json({ received: true });
}
