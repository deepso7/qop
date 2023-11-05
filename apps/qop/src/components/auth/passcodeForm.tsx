import * as z from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useStytch } from "@stytch/react";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import Spinner from "../spinner";

const formSchema = z.object({
  passcode: z.string().length(6),
});
type FormSchemaType = z.infer<typeof formSchema>;

const PasscodeForm = (props: {
  email: string;
  methodId: string;
  reset: () => void;
}) => {
  const stytch = useStytch();
  const queryClient = useQueryClient();

  const form = useForm<FormSchemaType>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      passcode: "",
    },
  });

  const passcodeMutation = useMutation({
    mutationFn: async (vars: FormSchemaType) => {
      await stytch.otps.authenticate(vars.passcode, props.methodId, {
        session_duration_minutes: 60,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user"] });
    },
    onError: (e) => {
      console.warn("error while validating otp", e);

      const resetStates = () => {
        form.reset();
        props.reset();
      };

      toast.error("Error while validating otp", {
        onAutoClose: resetStates,
        onDismiss: resetStates,
      });
    },
  });

  // 2. Define a submit handler.
  function onSubmit(values: FormSchemaType) {
    // Do something with the form values.
    // ✅ This will be type-safe and validated
    console.log({ values });
    passcodeMutation.mutate(values);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
        <FormField
          control={form.control}
          name="passcode"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Passcode</FormLabel>
              <FormControl>
                <Input placeholder="6 Digit Passcode" {...field} />
              </FormControl>
              <FormDescription>
                Passcode recieved on email: {props.email}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={passcodeMutation.status === "pending"}>
          {passcodeMutation.status === "pending" || passcodeMutation.isError ? (
            <Spinner />
          ) : (
            "Submit"
          )}
        </Button>
      </form>
    </Form>
  );
};

export default PasscodeForm;
