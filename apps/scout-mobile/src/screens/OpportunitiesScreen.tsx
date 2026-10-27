import OpportunityEditor from './OpportunityEditor';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, Pressable,
  StyleSheet, Text, TextInput, View
} from 'react-native';
import {
  addOpportunity,
  deleteOpportunity,
  listOpportunities,
  type Opportunity
} from '../storage/opportunities';

export default function OpportunitiesScreen() {
  const [items, setItems] = useState<Opportunity[]>([]);
  const [title, setTitle] = useState('');
  const [cost, setCost] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);

  async function refresh() {
    setItems(await listOpportunities());
  }

  useEffect(() => {
    let active = true;

    listOpportunities()
      .then(data => {
        if (active) setItems(data);
      })
      .catch(() => {
        if (active) setError('Stockage indisponible.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => { active = false; };
  }, []);

  async function save() {
    if (busy) return;

    const name = title.trim();
    const value = cost.trim();

    if (!name || name.length > 80) {
      Alert.alert('Nom invalide', 'Entre un nom de 1 à 80 caractères.');
      return;
    }

    if (value && !/^\d+(?:[,.]\d{1,2})?$/.test(value)) {
      Alert.alert('Coût invalide', 'Utilise un montant en euros, par exemple 8,50.');
      return;
    }

    const cents = value
      ? Math.round(Number(value.replace(',', '.')) * 100)
      : null;

    if (cents !== null && cents > 1000000) {
      Alert.alert('Montant trop élevé', 'Maximum : 10 000 €.');
      return;
    }

    setBusy(true);
    setError('');

    try {
      await addOpportunity(name, cents);
      await refresh();
      setTitle('');
      setCost('');
    } catch {
      setError("Impossible d'enregistrer l'opportunité.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    if (busy) return;

    setBusy(true);
    setError('');

    try {
      await deleteOpportunity(id);
      await refresh();
    } catch {
      setError('Suppression impossible.');
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete(item: Opportunity) {
    Alert.alert(
      'Supprimer cette opportunité ?',
      item.title,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer',
          style: 'destructive',
          onPress: () => { void remove(item.id); }
        }
      ]
    );
  }

  return (
    <View>
      <View style={s.card}>
        <Text style={s.heading}>Nouvelle opportunité</Text>

        <TextInput
          style={s.input}
          placeholder="Nom de l'opportunité"
          placeholderTextColor="#94a3b8"
          value={title}
          onChangeText={setTitle}
          maxLength={80}
        />

        <TextInput
          style={s.input}
          placeholder="Coût estimé en € (facultatif)"
          placeholderTextColor="#94a3b8"
          keyboardType="decimal-pad"
          value={cost}
          onChangeText={setCost}
        />

        <Pressable
          style={s.button}
          disabled={busy}
          onPress={() => { void save(); }}
        >
          <Text style={s.buttonText}>
            {busy ? 'En cours...' : 'Enregistrer'}
          </Text>
        </Pressable>

        <Text style={s.note}>
          Un coût enregistré n'autorise aucune dépense.
        </Text>
      </View>

      {error ? <Text style={s.error}>{error}</Text> : null}

      {loading ? (
        <ActivityIndicator color="#4ade80" />
      ) : items.length === 0 ? (
        <Text style={s.note}>Aucune opportunité enregistrée.</Text>
      ) : (
        items.map(item => (
          <View style={s.card} key={item.id}>
            <Text style={s.heading}>{item.title}</Text>

            <Text style={s.note}>
              Coût estimé : {
                item.cost_cents === null
                  ? 'Non renseigné'
                  : (item.cost_cents / 100)
                      .toFixed(2).replace('.', ',') + ' €'
              }
            </Text>


            <Text style={s.note}>
              Statut : {
                item.status === 'EN_ANALYSE'
                  ? 'En analyse'
                  : item.status === 'REFUSEE'
                    ? 'Refusée'
                    : 'À étudier'
              }
            </Text>

            {item.description ? (
              <Text style={s.note}>
                Description : {item.description}
              </Text>
            ) : null}

            {item.risks ? (
              <Text style={s.note}>
                Risques : {item.risks}
              </Text>
            ) : null}

            {item.sources ? (
              <Text style={s.note}>
                Sources déclarées : {item.sources}
              </Text>
            ) : null}

            {editingId === item.id ? (
              <OpportunityEditor
                item={item}
                onCancel={() => setEditingId(null)}
                onSaved={async () => {
                  await refresh();
                  setEditingId(null);
                }}
              />
            ) : (
              <Pressable
                style={s.button}
                onPress={() => setEditingId(item.id)}
              >
                <Text style={s.buttonText}>Modifier la fiche</Text>
              </Pressable>
            )}

            <Pressable
              disabled={busy}
              onPress={() => confirmDelete(item)}
            >
              <Text style={s.delete}>Supprimer</Text>
            </Pressable>
          </View>
        ))
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: '#1e293b',
    padding: 18,
    marginBottom: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#334155'
  },
  heading: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 14
  },
  input: {
    backgroundColor: '#101827',
    color: '#ffffff',
    borderWidth: 1,
    borderColor: '#475569',
    borderRadius: 10,
    padding: 14,
    marginBottom: 12
  },
  button: {
    backgroundColor: '#166534',
    padding: 15,
    borderRadius: 10,
    alignItems: 'center'
  },
  buttonText: {
    color: '#ffffff',
    fontWeight: 'bold'
  },
  note: {
    color: '#a8b4c7',
    marginTop: 12,
    lineHeight: 21
  },
  delete: {
    color: '#fca5a5',
    marginTop: 16,
    fontWeight: 'bold'
  },
  error: {
    color: '#fca5a5',
    marginBottom: 16
  }
});
