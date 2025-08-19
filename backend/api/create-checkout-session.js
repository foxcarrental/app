import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Parse the incoming request body to get amount, rentHistoryId, customerEmail
  const { amount, rentHistoryId, customerEmail, successUrl, cancelUrl } = req.body;

  // Basic validation
  if (!amount || !rentHistoryId) {
    return res.status(400).json({ error: "Amount and rentHistoryId are required." });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "aed", // Changed to AED as per your car rental app's currency
            product_data: {
              name: "Car Rental Payment",
              description: `Payment for agreement ${rentHistoryId}` // Dynamic description
            },
            unit_amount: Math.round(amount * 100), // Convert amount (e.g., AED) to cents (Stripe's smallest unit)
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: successUrl || `${req.headers.origin}/success.html?session_id={CHECKOUT_SESSION_ID}&rentHistoryId=${rentHistoryId}`,
      cancel_url: cancelUrl || `${req.headers.origin}/cancel.html?rentHistoryId=${rentHistoryId}`,
      client_reference_id: rentHistoryId, // Important: Pass your rentHistoryId to link webhook events
      customer_email: customerEmail, // Pre-fill customer email
    });

    res.json({ url: session.url, id: session.id }); // Return session ID along with URL
  } catch (err) {
    console.error("Stripe Error creating checkout session:", err.message);
    res.status(500).json({ error: err.message });
  }
}
