import React, { useState, useEffect } from 'react';
import { Bot, Save, MessageSquare } from 'lucide-react';
import { motion } from 'motion/react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';

export function IntelligentAssistant() {
  const { userData } = useAuth();
  const [behavior, setBehavior] = useState('');
  const [templateInput, setTemplateInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchSettings = async () => {
      if (!userData?.tenantId) return;
      try {
        const docRef = doc(db, `tenants/${userData.tenantId}/settings`, 'ai_assistant');
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          const data = docSnap.data();
          setBehavior(data.behavior || '');
          setTemplateInput(data.template || '');
        }
      } catch (error) {
        console.error('Error fetching AI settings:', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchSettings();
  }, [userData]);

  const handleSaveSettings = async () => {
    if (!userData?.tenantId) return;
    setIsSaving(true);
    try {
      const docRef = doc(db, `tenants/${userData.tenantId}/settings`, 'ai_assistant');
      await setDoc(docRef, {
        behavior,
        template: templateInput,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      alert('Configurações salvas com sucesso!');
    } catch (error) {
      console.error('Error saving AI settings:', error);
      alert('Erro ao salvar as configurações.');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return <div className="p-8 text-center text-gray-500">Carregando configurações...</div>;
  }

  return (
    <div className="max-w-7xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Assistente Inteligente</h1>
        <p className="text-gray-500 mt-1">Configure o comportamento da IA e crie templates de orçamento.</p>
      </div>

      <div className="space-y-8">
        <div className="bg-white p-8 rounded-[32px] border border-gray-100 shadow-sm">
          <div className="flex items-center space-x-3 mb-6">
            <div className="p-2 bg-yellow-50 rounded-xl">
              <Bot className="h-6 w-6 text-yellow-600" />
            </div>
            <h2 className="text-xl font-semibold text-gray-900">Configurações da IA</h2>
          </div>
          
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Configuração de Comportamento */}
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-2">Comportamento do Bot</h3>
                <p className="text-sm text-gray-500 mb-4">
                  Defina como a IA deve se comportar ao atender seus clientes. Especifique o tom de voz, 
                  informações importantes que ela deve sempre pedir, e como ela deve apresentar os orçamentos.
                </p>
                <textarea
                  rows={6}
                  value={behavior}
                  onChange={(e) => setBehavior(e.target.value)}
                  placeholder="Ex: Seja sempre muito educado e prestativo. Chame o cliente pelo nome. Sempre pergunte o modelo e ano do veículo antes de dar qualquer estimativa de preço..."
                  className="block w-full border border-gray-300 rounded-xl shadow-sm py-3 px-4 focus:outline-none focus:ring-yellow-500 focus:border-yellow-500 sm:text-sm"
                />
              </div>
            </div>

            {/* Template de Orçamento */}
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-2">Template de Orçamento</h3>
                <p className="text-sm text-gray-500 mb-4">
                  Crie um padrão visual para os orçamentos gerados pela IA. Isso garante consistência 
                  e evita que a IA formate os dados de maneira incorreta.
                </p>
                
                <textarea
                  rows={6}
                  value={templateInput}
                  onChange={(e) => setTemplateInput(e.target.value)}
                  placeholder="Ex: Olá {nome_cliente}! Segue o orçamento para o veículo {veiculo}: \n\nServiços:\n{servicos}\n\nPeças:\n{pecas}\n\nTotal: {total}"
                  className="block w-full border border-gray-300 rounded-xl shadow-sm py-3 px-4 focus:outline-none focus:ring-yellow-500 focus:border-yellow-500 sm:text-sm"
                />
              </div>
            </div>
          </div>
          
          <div className="mt-8 pt-6 border-t border-gray-100 flex justify-end">
            <button
              onClick={handleSaveSettings}
              disabled={isSaving}
              className="inline-flex items-center px-6 py-3 border border-transparent shadow-sm text-base font-medium rounded-xl text-white bg-yellow-600 hover:bg-yellow-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-yellow-500 disabled:opacity-50 transition-colors"
            >
              <Save className="mr-2 h-5 w-5" />
              {isSaving ? 'Salvando...' : 'Salvar Configurações'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
