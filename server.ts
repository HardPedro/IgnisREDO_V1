import express from 'express';
import { createServer as createViteServer } from 'vite';
import { db } from './server/firebase.js';
import { collection, query, where, getDocs, addDoc, updateDoc, doc, serverTimestamp, orderBy, getDoc } from 'firebase/firestore';
import path from 'path';
import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';

const generateQuoteFunctionDeclaration: FunctionDeclaration = {
  name: "generateQuote",
  parameters: {
    type: Type.OBJECT,
    description: "Gera um orçamento automático para o cliente com base nos serviços e peças solicitados.",
    properties: {
      services: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "Lista de serviços solicitados (ex: 'Troca de Óleo', 'Alinhamento')",
      },
      parts: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "Lista de peças solicitadas (ex: 'Filtro de Óleo', 'Pastilha de Freio')",
      },
      vehicle_make: {
        type: Type.STRING,
        description: "Marca do veículo do cliente (ex: 'Volkswagen', 'Fiat')",
      },
      vehicle_model: {
        type: Type.STRING,
        description: "Modelo do veículo do cliente (ex: 'Gol', 'Uno')",
      }
    },
    required: ["services"],
  },
};

async function processBotReply(tenantId: string, convId: string, waNumberData: any, customerPhone: string, customerName: string) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('GEMINI_API_KEY not configured.');
      return;
    }
    const ai = new GoogleGenAI({ apiKey });

    // Fetch catalog and AI settings
    const servicesRef = collection(db, `tenants/${tenantId}/services`);
    const partsRef = collection(db, `tenants/${tenantId}/parts`);
    const aiSettingsRef = doc(db, `tenants/${tenantId}/settings`, 'ai_assistant');
    
    const [servicesSnap, partsSnap, aiSettingsSnap] = await Promise.all([
      getDocs(servicesRef),
      getDocs(partsRef),
      getDoc(aiSettingsRef)
    ]);
    
    const catalog = {
      services: servicesSnap.docs.map(doc => ({ id: doc.id, ...doc.data() } as any)),
      parts: partsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() } as any))
    };
    
    const aiSettings = aiSettingsSnap.exists() ? aiSettingsSnap.data() : null;
    const customBehavior = aiSettings?.behavior ? `\nComportamento Customizado:\n${aiSettings.behavior}\n` : '';

    // Fetch recent messages
    const messagesRef = collection(db, `whatsapp_conversations/${convId}/messages`);
    const qMessages = query(messagesRef, orderBy('timestamp', 'asc'));
    const msgsSnap = await getDocs(qMessages);
    const messages = msgsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() } as any));

    let prompt = `Você é um assistente virtual de uma oficina mecânica. 
Responda de forma educada, prestativa e proativa. 
Seu objetivo é entender o que o cliente busca, tirar dúvidas e, se possível, perguntar se ele deseja um orçamento. Se ele confirmar que deseja, gere o orçamento.

Informações da Oficina (CATÁLOGO RESTRITO):
- Serviços Disponíveis: ${catalog.services.length > 0 ? catalog.services.map(s => s.name).join(', ') : 'Nenhum serviço cadastrado no momento.'}
- Peças em Estoque: ${catalog.parts.length > 0 ? catalog.parts.map(p => p.name).join(', ') : 'Nenhuma peça cadastrada no momento.'}
${customBehavior}
Diretrizes CRÍTICAS:
1. VOCÊ SÓ PODE OFERECER OS SERVIÇOS E PEÇAS LISTADOS ACIMA. É ESTRITAMENTE PROIBIDO inventar, sugerir ou oferecer qualquer serviço ou peça que não esteja na lista "Informações da Oficina".
2. Se o cliente pedir algo que não está na lista, diga educadamente que no momento a oficina não oferece esse serviço/peça.
3. Fluxo de atendimento: Entenda o problema -> Verifique se temos o serviço/peça -> Pergunte se o cliente deseja um orçamento -> Se SIM, use a ferramenta generateQuote.
4. Se o cliente pedir um orçamento, use a ferramenta generateQuote APENAS com os itens do catálogo.
5. Seja amigável e conciso.

Histórico da conversa:\n`;

    const recentMsgs = messages.slice(-10);
    recentMsgs.forEach(msg => {
      prompt += `${msg.direction === 'inbound' ? 'Cliente' : 'Oficina'}: ${msg.content}\n`;
    });
    prompt += "\nOficina:";

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        tools: [{ functionDeclarations: [generateQuoteFunctionDeclaration] }],
        systemInstruction: "Você é o assistente virtual da oficina. Siga rigorosamente o catálogo de serviços e peças. Não invente serviços. Siga o fluxo: entenda o problema, pergunte se quer orçamento, e se sim, gere usando a ferramenta generateQuote."
      }
    });

    let replyText = "";
    const functionCalls = response.functionCalls;
    
    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      if (call.name === 'generateQuote') {
        const args = call.args as any;
        try {
          let totalAmount = 0;
          const items: any[] = [];

          if (args.services) {
            args.services.forEach((serviceName: string) => {
              const service = catalog.services.find(s => s.name.toLowerCase().includes(serviceName.toLowerCase()));
              if (service) {
                items.push({ type: 'service', refId: service.id, name: service.name, qty: 1, unitPrice: service.price });
                totalAmount += service.price;
              } else {
                items.push({ type: 'service', refId: null, name: serviceName, qty: 1, unitPrice: 0 });
              }
            });
          }

          if (args.parts) {
            args.parts.forEach((partName: string) => {
              const part = catalog.parts.find(p => p.name.toLowerCase().includes(partName.toLowerCase()));
              if (part) {
                items.push({ type: 'part', refId: part.id, name: part.name, qty: 1, unitPrice: part.price });
                totalAmount += part.price;
              } else {
                items.push({ type: 'part', refId: null, name: partName, qty: 1, unitPrice: 0 });
              }
            });
          }

          // Find or create customer
          let customerId = null;
          const customersRef = collection(db, `tenants/${tenantId}/customers`);
          const qCustomer = query(customersRef, where('phone', '==', customerPhone));
          const customerSnapshot = await getDocs(qCustomer);
          
          if (!customerSnapshot.empty) {
            customerId = customerSnapshot.docs[0].id;
          } else {
            const newCustomerRef = await addDoc(customersRef, {
              name: customerName || 'Cliente WhatsApp',
              phone: customerPhone,
              createdAt: serverTimestamp()
            });
            customerId = newCustomerRef.id;
          }

          // Find or create vehicle if make/model provided
          let vehicleId = null;
          if (args.vehicle_make && args.vehicle_model) {
            const vehiclesRef = collection(db, `tenants/${tenantId}/vehicles`);
            const qVehicle = query(vehiclesRef, where('customerId', '==', customerId), where('make', '==', args.vehicle_make), where('model', '==', args.vehicle_model));
            const vehicleSnapshot = await getDocs(qVehicle);
            
            if (!vehicleSnapshot.empty) {
              vehicleId = vehicleSnapshot.docs[0].id;
            } else {
              const newVehicleRef = await addDoc(vehiclesRef, {
                customerId,
                make: args.vehicle_make,
                model: args.vehicle_model,
                year: '',
                plate: '',
                createdAt: serverTimestamp()
              });
              vehicleId = newVehicleRef.id;
            }
          }

          // Create quote
          const quotesRef = collection(db, `tenants/${tenantId}/quotes`);
          await addDoc(quotesRef, {
            customerId,
            vehicleId,
            items,
            totalAmount,
            status: 'pendente', // Enviado para aprovação do usuário do sistema
            createdAt: serverTimestamp()
          });

          replyText = `Acabei de gerar um pré-orçamento para você! O valor total estimado é de R$ ${totalAmount.toFixed(2)}. Ele foi enviado para a aprovação da nossa equipe e em breve entraremos em contato com os detalhes.`;
        } catch (err) {
          console.error('Error generating quote', err);
          replyText = "Tentei gerar o orçamento, mas ocorreu um erro no sistema. Um de nossos atendentes falará com você em breve.";
        }
      }
    } else {
      replyText = response.text || "Desculpe, não consegui entender. Pode repetir?";
    }

    if (replyText) {
      const zapiUrl = `https://api.z-api.io/instances/${waNumberData.instanceId}/token/${waNumberData.token}/send-text`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      if (waNumberData.clientToken) {
        headers['Client-Token'] = waNumberData.clientToken;
      }

      const res = await fetch(zapiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          phone: customerPhone,
          message: replyText
        })
      });

      if (res.ok) {
        const data = await res.json();
        const messagesRef = collection(db, `whatsapp_conversations/${convId}/messages`);
        await addDoc(messagesRef, {
          tenantId,
          wa_message_id: data.messageId,
          direction: 'outbound',
          type: 'text',
          content: replyText,
          status: 'sent',
          timestamp: serverTimestamp()
        });
        await updateDoc(doc(db, 'whatsapp_conversations', convId), {
          last_message_at: serverTimestamp()
        });
      } else {
        console.error('Failed to send bot reply via Z-API:', await res.text());
      }
    }

  } catch (error) {
    console.error('Error in processBotReply:', error);
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json());

  // Z-API Webhook for incoming messages
  app.post('/webhooks/zapi', async (req, res) => {
    try {
      const data = req.body;
      console.log('Z-API Webhook received event type:', data.type || 'unknown');
      
      // Z-API payload structure
      const instanceId = data.instanceId;
      
      if (!instanceId) {
        console.log('Webhook error: Missing instanceId');
        return res.status(400).send('Missing instanceId');
      }

      // 1. Ignore status updates (delivery, read receipts) if they come to this webhook
      if (data.status && !data.messageId && !data.id) {
        console.log('Ignoring status update event');
        return res.status(200).send('OK');
      }

      // 2. Ignore events that are not messages (like connection status, presence, etc)
      if (!data.phone || (!data.messageId && !data.id)) {
        console.log('Ignoring non-message event from Z-API');
        return res.status(200).send('OK'); // Always return 200 so Z-API doesn't retry
      }

      // 3. Ignore group messages (usually we only want 1-on-1 customer service)
      if (data.isGroup || data.phone.includes('-')) {
        console.log('Ignoring group message');
        return res.status(200).send('OK');
      }

      const phone = data.phone;
      const messageId = data.messageId || data.id;
      const fromMe = data.fromMe || false;
      const type = data.type?.toLowerCase() || 'other';
      
      // Extract text robustly based on message type
      let text = '';
      if (data.text && data.text.message) {
        text = data.text.message;
      } else if (typeof data.message === 'string') {
        text = data.message;
      } else if (type === 'audio') {
        text = '🎵 Áudio recebido';
      } else if (type === 'image') {
        text = '📷 Imagem recebida';
      } else if (type === 'document') {
        text = '📄 Documento recebido';
      } else if (type === 'video') {
        text = '🎥 Vídeo recebido';
      } else if (type === 'sticker') {
        text = '🎫 Figurinha recebida';
      } else if (type === 'location') {
        text = '📍 Localização recebida';
      } else if (type === 'contacts') {
        text = '👤 Contato recebido';
      } else {
        text = `[Mensagem do tipo: ${type}]`;
      }
      
      // Find the whatsapp_number by instanceId
      const numbersRef = collection(db, 'whatsapp_numbers');
      const qNumber = query(numbersRef, where('instanceId', '==', instanceId));
      const numberSnap = await getDocs(qNumber);
      
      if (numberSnap.empty) {
        console.log(`Webhook error: Instance ${instanceId} not found in database`);
        return res.status(404).send('Instance not found');
      }
      
      const waNumber = numberSnap.docs[0];
      const tenantId = waNumber.data().tenantId;
      
      // Find or create conversation
      const convsRef = collection(db, 'whatsapp_conversations');
      const qConv = query(convsRef, 
        where('whatsapp_number_id', '==', waNumber.id),
        where('customer_phone', '==', phone)
      );
      const convSnap = await getDocs(qConv);
      
      let convId;
      let botActive = true;
      let customerName = data.senderName || data.chatName || phone;

      if (convSnap.empty) {
        const newConv = await addDoc(convsRef, {
          tenantId,
          whatsapp_number_id: waNumber.id,
          customer_phone: phone,
          customer_name: customerName,
          last_message_at: serverTimestamp(),
          bot_active: true,
          status: 'open'
        });
        convId = newConv.id;
        console.log(`Created new conversation: ${convId} for phone: ${phone}`);
      } else {
        convId = convSnap.docs[0].id;
        botActive = convSnap.docs[0].data().bot_active !== false;
        await updateDoc(doc(db, 'whatsapp_conversations', convId), {
          last_message_at: serverTimestamp(),
          customer_name: customerName
        });
        console.log(`Updated conversation: ${convId} for phone: ${phone}`);
      }
      
      // Check if message already exists to prevent duplicates (Z-API sometimes retries)
      const messagesRef = collection(db, `whatsapp_conversations/${convId}/messages`);
      const qMsg = query(messagesRef, where('wa_message_id', '==', messageId));
      const msgSnap = await getDocs(qMsg);
      
      if (!msgSnap.empty) {
        console.log(`Message ${messageId} already exists, ignoring duplicate.`);
        return res.status(200).send('OK');
      }

      // Save message
      await addDoc(messagesRef, {
        tenantId,
        wa_message_id: messageId,
        direction: fromMe ? 'outbound' : 'inbound',
        type: type === 'text' ? 'text' : 'other',
        content: text,
        status: fromMe ? 'sent' : 'received',
        timestamp: serverTimestamp()
      });
      console.log(`Message saved successfully to conv ${convId}`);

      res.status(200).send('OK');

      // Trigger bot reply in background if active and message is inbound
      if (!fromMe && botActive) {
        processBotReply(tenantId, convId, waNumber.data(), phone, customerName);
      }
    } catch (error) {
      console.error('Z-API Webhook Error:', error);
      // Always return 200 to Z-API even on our internal errors so it doesn't keep retrying and blocking the queue
      res.status(200).send('Internal Server Error Handled');
    }
  });

  // API to send WhatsApp message via Z-API
  app.post('/api/whatsapp/messages', async (req, res) => {
    try {
      const { to, type, text, mediaUrl, mediaType, fileName, instanceId, token, clientToken: bodyClientToken } = req.body;
      
      if (!to || !instanceId || !token) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      let clientToken = bodyClientToken || '';

      // If not provided in body, try to fetch from database as fallback
      if (!clientToken) {
        const numbersRef = collection(db, 'whatsapp_numbers');
        const qNumber = query(numbersRef, where('instanceId', '==', instanceId));
        const numberSnap = await getDocs(qNumber);
        
        if (!numberSnap.empty && numberSnap.docs[0].data().clientToken) {
          clientToken = numberSnap.docs[0].data().clientToken;
        }
      }

      let endpoint = 'send-text';
      let requestBody: any = { phone: to };

      if (mediaUrl) {
        if (mediaType === 'image') {
          endpoint = 'send-image';
          requestBody.image = mediaUrl;
          if (text) requestBody.caption = text;
        } else if (mediaType === 'video') {
          endpoint = 'send-video';
          requestBody.video = mediaUrl;
          if (text) requestBody.caption = text;
        } else if (mediaType === 'audio') {
          endpoint = 'send-audio';
          requestBody.audio = mediaUrl;
        } else if (mediaType === 'document') {
          endpoint = 'send-document';
          requestBody.document = mediaUrl;
          requestBody.fileName = fileName || 'documento';
          if (text) requestBody.caption = text;
        }
      } else {
        requestBody.message = text;
      }

      const zapiUrl = `https://api.z-api.io/instances/${instanceId}/token/${token}/${endpoint}`;
      
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      
      if (clientToken) {
        headers['Client-Token'] = clientToken;
      }

      const response = await fetch(zapiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorData = await response.text();
        console.error('Z-API Send Error:', errorData);
        return res.status(response.status).json({ error: 'Failed to send message via Z-API', details: errorData });
      }

      const data = await response.json();
      res.json({ success: true, messageId: data.messageId });
    } catch (error) {
      console.error('Error sending WhatsApp message:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // API to manually generate quote via bot
  app.post('/api/whatsapp/manual-quote', async (req, res) => {
    try {
      const { tenantId, convId, customerPhone, customerName, waNumberData } = req.body;
      
      if (!tenantId || !convId || !customerPhone || !waNumberData) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // We can just call processBotReply but we might want to force it to generate a quote.
      // To keep it simple, we will just call processBotReply and let the AI decide, 
      // or we can write a specific prompt for manual quote generation.
      
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: 'GEMINI_API_KEY not configured.' });
      }
      const ai = new GoogleGenAI({ apiKey });

      const servicesRef = collection(db, `tenants/${tenantId}/services`);
      const partsRef = collection(db, `tenants/${tenantId}/parts`);
      const aiSettingsRef = doc(db, `tenants/${tenantId}/settings`, 'ai_assistant');
      
      const [servicesSnap, partsSnap, aiSettingsSnap] = await Promise.all([
        getDocs(servicesRef),
        getDocs(partsRef),
        getDoc(aiSettingsRef)
      ]);
      
      const catalog = {
        services: servicesSnap.docs.map(doc => ({ id: doc.id, ...doc.data() } as any)),
        parts: partsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() } as any))
      };
      
      const aiSettings = aiSettingsSnap.exists() ? aiSettingsSnap.data() : null;
      const customBehavior = aiSettings?.behavior ? `\nComportamento Customizado:\n${aiSettings.behavior}\n` : '';

      const messagesRef = collection(db, `whatsapp_conversations/${convId}/messages`);
      const qMessages = query(messagesRef, orderBy('timestamp', 'asc'));
      const msgsSnap = await getDocs(qMessages);
      const messages = msgsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() } as any));

      let prompt = `Analise a conversa abaixo e extraia os serviços, peças e o modelo/marca do veículo mencionados pelo cliente para gerar um orçamento.

Informações da Oficina (CATÁLOGO RESTRITO):
- Serviços Disponíveis: ${catalog.services.length > 0 ? catalog.services.map(s => s.name).join(', ') : 'Nenhum serviço cadastrado no momento.'}
- Peças em Estoque: ${catalog.parts.length > 0 ? catalog.parts.map(p => p.name).join(', ') : 'Nenhuma peça cadastrada no momento.'}
${customBehavior}
Diretrizes CRÍTICAS:
1. VOCÊ SÓ PODE INCLUIR NO ORÇAMENTO OS SERVIÇOS E PEÇAS LISTADOS ACIMA.
2. Se o cliente pedir algo que não está na lista, NÃO inclua no orçamento.
3. Se não houver serviços claros na conversa que correspondam ao catálogo, não gere o orçamento.

Conversa:\n`;
      const recentMsgs = messages.slice(-20);
      recentMsgs.forEach(msg => {
        prompt += `${msg.direction === 'inbound' ? 'Cliente' : 'Oficina'}: ${msg.content}\n`;
      });

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: {
          tools: [{ functionDeclarations: [generateQuoteFunctionDeclaration] }],
          systemInstruction: "Você é um assistente de oficina. Use a ferramenta generateQuote para criar um orçamento baseado na conversa. Siga rigorosamente o catálogo de serviços e peças."
        }
      });

      let replyText = "";
      const functionCalls = response.functionCalls;
      
      if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0];
        if (call.name === 'generateQuote') {
          const args = call.args as any;
          try {
            let totalAmount = 0;
            const items: any[] = [];

            if (args.services) {
              args.services.forEach((serviceName: string) => {
                const service = catalog.services.find(s => s.name.toLowerCase().includes(serviceName.toLowerCase()));
                if (service) {
                  items.push({ type: 'service', refId: service.id, name: service.name, qty: 1, unitPrice: service.price });
                  totalAmount += service.price;
                } else {
                  items.push({ type: 'service', refId: null, name: serviceName, qty: 1, unitPrice: 0 });
                }
              });
            }

            if (args.parts) {
              args.parts.forEach((partName: string) => {
                const part = catalog.parts.find(p => p.name.toLowerCase().includes(partName.toLowerCase()));
                if (part) {
                  items.push({ type: 'part', refId: part.id, name: part.name, qty: 1, unitPrice: part.price });
                  totalAmount += part.price;
                } else {
                  items.push({ type: 'part', refId: null, name: partName, qty: 1, unitPrice: 0 });
                }
              });
            }

            let customerId = null;
            const customersRef = collection(db, `tenants/${tenantId}/customers`);
            const qCustomer = query(customersRef, where('phone', '==', customerPhone));
            const customerSnapshot = await getDocs(qCustomer);
            
            if (!customerSnapshot.empty) {
              customerId = customerSnapshot.docs[0].id;
            } else {
              const newCustomerRef = await addDoc(customersRef, {
                name: customerName || 'Cliente WhatsApp',
                phone: customerPhone,
                createdAt: serverTimestamp()
              });
              customerId = newCustomerRef.id;
            }

            let vehicleId = null;
            if (args.vehicle_make && args.vehicle_model) {
              const vehiclesRef = collection(db, `tenants/${tenantId}/vehicles`);
              const qVehicle = query(vehiclesRef, where('customerId', '==', customerId), where('make', '==', args.vehicle_make), where('model', '==', args.vehicle_model));
              const vehicleSnapshot = await getDocs(qVehicle);
              
              if (!vehicleSnapshot.empty) {
                vehicleId = vehicleSnapshot.docs[0].id;
              } else {
                const newVehicleRef = await addDoc(vehiclesRef, {
                  customerId,
                  make: args.vehicle_make,
                  model: args.vehicle_model,
                  year: '',
                  plate: '',
                  createdAt: serverTimestamp()
                });
                vehicleId = newVehicleRef.id;
              }
            }

            const quotesRef = collection(db, `tenants/${tenantId}/quotes`);
            await addDoc(quotesRef, {
              customerId,
              vehicleId,
              items,
              totalAmount,
              status: 'pendente',
              createdAt: serverTimestamp()
            });

            replyText = `Acabei de gerar um pré-orçamento para você! O valor total estimado é de R$ ${totalAmount.toFixed(2)}. Posso enviar o link ou os detalhes se desejar.`;
          } catch (err) {
            console.error('Error generating quote', err);
            replyText = "Tentei gerar o orçamento, mas ocorreu um erro no sistema.";
          }
        }
      } else {
        replyText = "Não consegui identificar os serviços na conversa para gerar o orçamento.";
      }

      if (replyText) {
        const zapiUrl = `https://api.z-api.io/instances/${waNumberData.instanceId}/token/${waNumberData.token}/send-text`;
        const headers: Record<string, string> = {
          'Content-Type': 'application/json'
        };
        if (waNumberData.clientToken) {
          headers['Client-Token'] = waNumberData.clientToken;
        }

        const resZapi = await fetch(zapiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            phone: customerPhone,
            message: replyText
          })
        });

        if (resZapi.ok) {
          const data = await resZapi.json();
          const messagesRef = collection(db, `whatsapp_conversations/${convId}/messages`);
          await addDoc(messagesRef, {
            tenantId,
            wa_message_id: data.messageId,
            direction: 'outbound',
            type: 'text',
            content: replyText,
            status: 'sent',
            timestamp: serverTimestamp()
          });
          await updateDoc(doc(db, 'whatsapp_conversations', convId), {
            last_message_at: serverTimestamp()
          });
        }
      }

      res.json({ success: true, replyText });
    } catch (error) {
      console.error('Error in manual quote:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
