import { supabase } from '../lib/supabaseClient';

export async function summarizeDocument({ fileName, docType, nature, contentText, imageBase64, imagesBase64, imageMediaType, categories, services }) {
  const { data, error } = await supabase.functions.invoke('summarize-document', {
    body: { fileName, docType, nature, contentText, imageBase64, imagesBase64, imageMediaType, categories, services },
  });
  if (error) throw error;
  return data;
}

export async function chatWithDocument({
  documentName, documentContent, history, question,
  attachmentName, attachedText, attachmentSizeKb, imageBase64, imageMediaType,
}) {
  const { data, error } = await supabase.functions.invoke('chat-with-document', {
    body: {
      documentName, documentContent, history, question,
      attachmentName, attachedText, attachmentSizeKb, imageBase64, imageMediaType,
    },
  });
  if (error) throw error;
  return data;
}
