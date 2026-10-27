import React, { useState } from 'react';
import {
  Pressable, StyleSheet, Text, TextInput, View
} from 'react-native';

import {
  parseMobileResearchImport,
  type ImportedPreview
} from '../domain/mobileResearchImport';

export default function ResearchImportsScreen() {
  const [raw, setRaw] = useState('');
  const [preview, setPreview] = useState<ImportedPreview | null>(null);
  const [error, setError] = useState('');

  function load() {
    setPreview(null);
    setError('');

    try {
      setPreview(parseMobileResearchImport(raw));
    } catch {
      setError('Résultat invalide ou non conforme au contrat Scout.');
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Résultats Scout</Text>

      <Text style={styles.note}>
        Import manuel expérimental. Les données importées
        ne sont pas authentifiées et ne donnent aucune
        autorisation commerciale.
      </Text>

      <TextInput
        style={styles.input}
        multiline
        textAlignVertical="top"
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Coller ici un résultat JSON Scout"
        placeholderTextColor="#94a3b8"
        value={raw}
        onChangeText={setRaw}
        maxLength={12000}
      />

      <Pressable style={styles.button} onPress={load}>
        <Text style={styles.buttonText}>Examiner le résultat</Text>
      </Pressable>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {preview && (
        <>
          <Text style={styles.note}>
            Statut importé : {preview.status}
          </Text>

          {preview.cards.length === 0 && (
            <Text style={styles.note}>
              Aucune opportunité à afficher.
            </Text>
          )}

          {preview.cards.map((item, index) => (
            <View key={index} style={styles.result}>
              <Text style={styles.title}>{item.name}</Text>

              <Text style={styles.note}>
                Coût : {item.cost_cents === null
                  ? 'Inconnu'
                  : (item.cost_cents / 100).toFixed(2) + ' €'}
              </Text>

              <Text style={styles.note}>
                Base du coût : {item.cost_basis}
              </Text>

              <Text style={styles.note}>
                Source déclarée : {item.source_url}
              </Text>

              <Text style={styles.note}>
                Citation : {item.source_quote}
              </Text>

              <Text style={styles.warning}>
                Citation concordante dans les données reçues.
                Source non authentifiée. Aucune dépense autorisée.
              </Text>
            </View>
          ))}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1e293b',
    padding: 18,
    borderRadius: 14,
    marginBottom: 16
  },
  title: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 18,
    marginBottom: 12
  },
  note: {
    color: '#a8b4c7',
    marginBottom: 12,
    lineHeight: 21
  },
  input: {
    backgroundColor: '#101827',
    color: '#ffffff',
    borderColor: '#475569',
    borderWidth: 1,
    borderRadius: 10,
    minHeight: 100,
    padding: 12,
    marginBottom: 12
  },
  button: {
    backgroundColor: '#166534',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center'
  },
  buttonText: {
    color: '#ffffff',
    fontWeight: 'bold'
  },
  error: {
    color: '#fca5a5',
    marginTop: 12
  },
  result: {
    borderTopWidth: 1,
    borderTopColor: '#475569',
    marginTop: 16,
    paddingTop: 16
  },
  warning: {
    color: '#fbbf24',
    marginTop: 10,
    lineHeight: 20
  }
});
